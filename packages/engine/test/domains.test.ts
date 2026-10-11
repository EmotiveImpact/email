import { eq, messages, newId, tenants } from '@platform/db';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalProvisioner, LogTransport, PlatformError, REPUTATION_LIMITS } from '../src/index.ts';
import { setup } from '../src/testing.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** A provisioner whose domains verify only when the test says so. */
class ControlledProvisioner extends LocalProvisioner {
  readonly verified = new Set<string>();
  override async domainStatus(domain: string) {
    return this.verified.has(domain) ? ('verified' as const) : ('pending' as const);
  }
}

async function start(options: { dmarc?: boolean } = {}) {
  const provisioner = new ControlledProvisioner();
  const transport = new LogTransport();
  const ctx = await setup({
    transport,
    provisioner,
    config: { verifiedDomainsOnly: true },
    resolveTxt: async (name) => (options.dmarc && name.startsWith('_dmarc.') ? [['v=DMARC1; p=none;']] : []),
  });
  close = ctx.close;
  return { ...ctx, provisioner, transport };
}

const failsWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PlatformError);
  expect((error as PlatformError).code).toBe(code);
};

describe('sending domains', () => {
  it('gives every business its own SES tenant', async () => {
    const { tenant, provisioner } = await start();
    expect(tenant.sesTenant).toBe(`t-${tenant.id}`);
    expect(provisioner.tenants.has(`t-${tenant.id}`)).toBe(true);
  });

  it('sends from the platform address, with replies to the business, until its domain is verified', async () => {
    const { engine, app, tenant, provisioner, drain, transport, queue } = await start({ dmarc: true });
    const before = await engine.sendEmail(app, { tenant: 'linden', to: 'ama@example.com', subject: 'Hi', text: 'Hi' });
    expect(before).toMatchObject({ from: 'Linden Studio <hello@platform.test>', replyTo: 'news@linden.test' });
    await failsWith(engine.sendEmail(app, { tenant: 'linden', from: 'news@linden.test', to: 'ama@example.com', subject: 'Hi', text: 'Hi' }), 'domain_not_verified');

    const added = await engine.addDomain(tenant.id, 'https://Linden.TEST/');
    expect(added).toMatchObject({ domain: 'linden.test', status: 'pending' });
    expect(added.records).toHaveLength(3);
    expect(added.records[0]!.name).toMatch(/\._domainkey\.linden\.test$/);
    expect(queue.jobs.some((j) => j.name === 'check-domain')).toBe(true);

    // Still pending: the check keeps itself scheduled.
    queue.jobs.splice(queue.jobs.findIndex((j) => j.name === 'check-domain'), 1);
    await engine.runJob('check-domain', { domainId: added.id });
    expect(queue.jobs.filter((j) => j.name === 'check-domain')).toHaveLength(1);

    provisioner.verified.add('linden.test');
    const checked = await engine.checkTenantDomain(tenant.id, added.id);
    expect(checked).toMatchObject({ status: 'verified', dmarc: true });
    expect(checked.verifiedAt).toBeInstanceOf(Date);

    const after = await engine.sendEmail(app, { tenant: 'linden', to: 'ama@example.com', subject: 'Hi', text: 'Hi' });
    expect(after.from).toBe('Linden Studio <news@linden.test>');
    await drain();
    expect(transport.sent.map((m) => m.sesTenant)).toEqual([`t-${tenant.id}`, `t-${tenant.id}`]);
  });

  it('keeps a domain with the business that set it up', async () => {
    const { engine, tenant, appId } = await start();
    await engine.addDomain(tenant.id, 'linden.test');
    const other = await engine.upsertTenant(appId, 'harbour', { name: 'Harbour Spa' });
    await failsWith(engine.addDomain(other.id, 'linden.test'), 'domain_taken');
    await failsWith(engine.addDomain(other.id, 'not a domain'), 'invalid_request');
    expect((await engine.addDomain(tenant.id, 'linden.test')).domain).toBe('linden.test');
  });
});

describe('reputation', () => {
  it('pauses a business whose bounces climb, holds its email, and sends it on resume', async () => {
    const { engine, app, tenant, db, drain, transport, queue } = await start();
    // A week of history: 300 sent, 15 of them bounced (5%).
    const now = new Date();
    await db.insert(messages).values(
      Array.from({ length: 300 }, (_, i) => ({
        id: newId('msg'),
        tenantId: tenant.id,
        stream: 'transactional' as const,
        to: `client${i}@example.com`,
        from: 'x',
        subject: 'Old',
        status: (i < 14 ? 'bounced' : 'delivered') as 'bounced' | 'delivered',
        providerMessageId: `old-${i}`,
        sentAt: now,
      })),
    );
    const [last] = await db.select().from(messages).where(eq(messages.providerMessageId, 'old-299'));
    await db.update(messages).set({ status: 'sent' }).where(eq(messages.id, last!.id));
    await engine.ingestSesEvent({ eventType: 'Bounce', mail: { messageId: 'old-299', timestamp: now.toISOString(), tags: {} }, bounce: { bounceType: 'Permanent' } });

    const [paused] = await db.select().from(tenants).where(eq(tenants.id, tenant.id));
    expect(paused!.status).toBe('paused');
    expect(paused!.pausedReason).toMatch(/bounced/);
    expect((await engine.reputation(tenant.id)).bounceRate).toBeGreaterThan(REPUTATION_LIMITS.bounceRate);

    // New email is refused at the door; email already queued is held, not lost.
    await failsWith(engine.sendEmail(app, { tenant: 'linden', to: 'kofi@example.com', subject: 'Hi', text: 'Hi' }), 'tenant_paused');
    const [queued] = await db
      .insert(messages)
      .values({ id: newId('msg'), tenantId: tenant.id, stream: 'transactional', to: 'ama@example.com', from: 'x', subject: 'Queued earlier', text: 'x' })
      .returning();
    await engine.processSend(queued!.id);
    const [held] = await db.select().from(messages).where(eq(messages.id, queued!.id));
    expect(held).toMatchObject({ status: 'queued', error: 'paused' });
    expect(transport.sent).toHaveLength(0);

    queue.jobs.length = 0;
    await engine.resumeTenant(tenant.id);
    await drain();
    expect(transport.sent.map((m) => m.subject)).toEqual(['Queued earlier']);
  });
});
