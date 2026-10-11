import { campaigns, eq, messages } from '@platform/db';
import { afterEach, describe, expect, it } from 'vitest';
import { LogTransport, PlatformError } from '../src/index.ts';
import { setup } from '../src/testing.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** Linden Studio with three clients: two said yes to news, one did not. */
async function studio() {
  const transport = new LogTransport();
  const ctx = await setup({ transport });
  close = ctx.close;
  const { engine, app } = ctx;
  await engine.upsertContact(app, { tenant: 'linden', email: 'ama@example.com', firstName: 'Ama', attributes: { treatment: 'Facial' }, consent: { marketing: 'granted', source: 'test' } });
  await engine.upsertContact(app, { tenant: 'linden', email: 'kofi@example.com', firstName: 'Kofi', attributes: { treatment: 'Massage' }, consent: { marketing: 'granted', source: 'test' } });
  await engine.upsertContact(app, { tenant: 'linden', email: 'maya@example.com', firstName: 'Maya', attributes: { treatment: 'Facial' } });
  const content = {
    preview: 'Space this week',
    blocks: [
      { id: 'h', type: 'heading', text: 'Hello {{first_name|there}}' },
      { id: 't', type: 'text', text: 'We have space on **Thursday**.' },
      { id: 'b', type: 'button', label: 'Book', url: 'https://linden.test/book' },
    ],
  };
  return { ...ctx, transport, content };
}

const failsWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PlatformError);
  expect((error as PlatformError).code).toBe(code);
};

describe('campaigns', () => {
  it('starts from a ready-made draft', async () => {
    const { engine, tenant } = await studio();
    const draft = await engine.createCampaign(tenant.id, {});
    expect(draft.status).toBe('draft');
    expect(draft).toMatchObject({ name: 'Space this week', subject: 'A few spaces this week, {{first_name|there}}' });
    const detail = await engine.campaignDetail(tenant.id, draft.id);
    // Linden has no booking link, so the starter's button has nowhere to go yet.
    expect(detail.problems).not.toContain('Add a subject line.');
    expect(detail.problems.some((p) => p.includes('button needs a link'))).toBe(true);
    expect(detail.audience).toEqual({ total: 3, noConsent: 1, suppressed: 0, eligible: 2 });
  });

  it('sends one personal message to each person who said yes, and none to anyone else', async () => {
    const { engine, tenant, content, transport, drain, db } = await studio();
    const draft = await engine.createCampaign(tenant.id, { name: 'Thursday space', subject: '{{first_name}}, Thursday is free', content });
    await engine.scheduleCampaign(tenant.id, draft.id);
    await drain();

    expect(transport.sent.map((m) => m.to).sort()).toEqual(['ama@example.com', 'kofi@example.com']);
    const ama = transport.sent.find((m) => m.to === 'ama@example.com')!;
    expect(ama.subject).toBe('Ama, Thursday is free');
    expect(ama.from).toBe('Linden Studio <news@linden.test>');
    expect(ama.html).toContain('Hello Ama');
    expect(ama.html).toContain('<strong>Thursday</strong>');
    // Each person gets their own working unsubscribe link, in the footer and the header.
    const link = ama.headers['List-Unsubscribe']!.slice(1, -1);
    expect(link).toMatch(/^https:\/\/api\.test\/u\//);
    expect(ama.html).toContain(link);
    expect(ama.html).not.toContain('{{');
    expect(ama.text).toContain('Hello Ama');

    const [sent] = await db.select().from(campaigns).where(eq(campaigns.id, draft.id));
    expect(sent).toMatchObject({ status: 'sent', recipients: 2, skippedNoConsent: 1, skippedSuppressed: 0 });
    const stats = (await engine.campaignDetail(tenant.id, draft.id)).stats!;
    expect(stats).toMatchObject({ total: 2, pending: 0 });
  });

  it('sends to a segment only, and paces sends to the account rate', async () => {
    const { engine, tenant, content, queue } = await studio();
    const segment = await engine.saveSegment(tenant.id, {
      name: 'Facial clients',
      definition: { conditions: [{ type: 'attribute', key: 'treatment', op: 'equals', value: 'facial' }] },
    });
    const draft = await engine.createCampaign(tenant.id, { subject: 'Hi', content, segmentId: segment.id });
    expect(await engine.audienceFor(tenant.id, segment.id)).toEqual({ total: 2, noConsent: 1, suppressed: 0, eligible: 1 });
    await engine.scheduleCampaign(tenant.id, draft.id);
    await engine.processCampaign(draft.id);
    const sends = queue.jobs.filter((j) => j.name === 'send-message');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.startAfter).toBeInstanceOf(Date);
  });

  it('runs a send twice without sending twice', async () => {
    const { engine, tenant, content, transport, drain, db } = await studio();
    const draft = await engine.createCampaign(tenant.id, { subject: 'Hi', content });
    await engine.scheduleCampaign(tenant.id, draft.id);
    // A retried job after a crash mid-send.
    await db.update(campaigns).set({ status: 'sending' }).where(eq(campaigns.id, draft.id));
    await engine.processCampaign(draft.id);
    await db.update(campaigns).set({ status: 'sending' }).where(eq(campaigns.id, draft.id));
    await engine.processCampaign(draft.id);
    await drain();
    expect(transport.sent).toHaveLength(2);
    expect(await db.select().from(messages).where(eq(messages.campaignId, draft.id))).toHaveLength(2);
  });

  it('skips someone who unsubscribed after the campaign was queued', async () => {
    const { engine, tenant, content, transport, queue, db } = await studio();
    const first = await engine.createCampaign(tenant.id, { subject: 'One', content });
    await engine.scheduleCampaign(tenant.id, first.id);
    await queue.drain((name, data) => engine.runJob(name, data));
    const amaMessage = transport.sent.find((m) => m.to === 'ama@example.com')!;
    const token = amaMessage.headers['List-Unsubscribe']!.split('/u/')[1]!.slice(0, -1);

    const second = await engine.createCampaign(tenant.id, { subject: 'Two', content });
    await engine.scheduleCampaign(tenant.id, second.id);
    await engine.processCampaign(second.id);
    // Ama unsubscribes from the first email while the second is still queued.
    await engine.unsubscribe(token);
    await queue.drain((name, data) => engine.runJob(name, data));

    const secondTo = transport.sent.filter((m) => m.subject === 'Two').map((m) => m.to);
    expect(secondTo).toEqual(['kofi@example.com']);
    const [held] = await db.select().from(messages).where(eq(messages.to, 'ama@example.com')).then((rows) => rows.filter((r) => r.subject === 'Two'));
    expect(held).toMatchObject({ status: 'suppressed', error: 'unsubscribe' });
    expect((await engine.campaignDetail(tenant.id, first.id)).stats!.unsubscribed).toBe(1);
  });

  it('can be unscheduled, and then the queued job does nothing', async () => {
    const { engine, tenant, content, transport, drain } = await studio();
    const draft = await engine.createCampaign(tenant.id, { subject: 'Later', content });
    const scheduled = await engine.scheduleCampaign(tenant.id, draft.id, new Date(Date.now() + 86_400_000));
    expect(scheduled.status).toBe('scheduled');
    await failsWith(engine.updateCampaign(tenant.id, draft.id, { subject: 'Changed' }), 'not_editable');
    await engine.unscheduleCampaign(tenant.id, draft.id);
    await drain();
    expect(transport.sent).toHaveLength(0);
    expect((await engine.updateCampaign(tenant.id, draft.id, { subject: 'Changed' })).subject).toBe('Changed');
  });

  it('refuses to send something unfinished', async () => {
    const { engine, tenant, content, appId } = await studio();
    const noAddress = await engine.upsertTenant(appId, 'harbour', { name: 'Harbour Spa' });
    const fromHarbour = await engine.createCampaign(noAddress.id, { subject: 'Hi', content });
    expect((await engine.campaignDetail(noAddress.id, fromHarbour.id)).problems).toContain('Add your postal address in Appearance; it goes at the foot of the email.');
    const noSubject = await engine.createCampaign(tenant.id, { content });
    await failsWith(engine.scheduleCampaign(tenant.id, noSubject.id), 'not_ready');
    const typo = await engine.createCampaign(tenant.id, { subject: 'Hi {{frist_name}}', content });
    await failsWith(engine.scheduleCampaign(tenant.id, typo.id), 'not_ready');
    await failsWith(engine.createCampaign(tenant.id, { content: { blocks: [{ id: 'b', type: 'button', label: 'x', url: 'javascript:alert(1)' }] } }), 'invalid_request');
  });

  it('sends a test copy with sample details', async () => {
    const { engine, tenant, content, transport, drain } = await studio();
    const draft = await engine.createCampaign(tenant.id, { subject: 'Hello {{first_name}}', content });
    await engine.sendTest(tenant.id, draft.id, 'Owner@Linden.test');
    await drain();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ to: 'owner@linden.test', subject: '[Test] Hello Ama' });
    expect((await engine.campaignDetail(tenant.id, draft.id)).status).toBe('draft');
    const preview = await engine.previewCampaign(tenant.id, content);
    expect(preview).toContain('Hello Ama');
    expect(preview).not.toContain('{{');
  });
});
