import { generateKeyPairSync, createSign } from 'node:crypto';
import { eq, messages, suppressions } from '@platform/db';
import { Webhook } from 'standardwebhooks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LogTransport,
  parseSesEvent,
  PermanentSendError,
  PlatformError,
  primeSnsCertificate,
  verifySnsMessage,
  type OutgoingEmail,
  type SnsMessage,
} from '../src/index.ts';
import { setup } from '../src/testing.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(options?: Parameters<typeof setup>[0]) {
  const ctx = await setup(options);
  close = ctx.close;
  return ctx;
}

const sesEvent = (eventType: string, providerMessageId: string, section: Record<string, unknown> = {}) => ({
  eventType,
  mail: { messageId: providerMessageId, timestamp: '2026-10-11T09:00:00.000Z', tags: {} },
  ...section,
});

describe('sending', () => {
  it('queues a transactional email, sends it once, and honours idempotency keys', async () => {
    const { engine, app, drain, transport } = await start();
    const first = await engine.sendEmail(app, {
      tenant: 'linden',
      to: 'Ama@Example.com ',
      subject: 'Your facial is tomorrow at 10:00',
      text: 'See you tomorrow.',
      idempotencyKey: 'reminder-123',
    });
    expect(first.status).toBe('queued');
    expect(first.to).toBe('ama@example.com');
    expect(first.from).toBe('news@linden.test');

    const again = await engine.sendEmail(app, { tenant: 'linden', to: 'ama@example.com', subject: 'x', text: 'x', idempotencyKey: 'reminder-123' });
    expect(again.id).toBe(first.id);

    await drain();
    const log = transport as LogTransport;
    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]!.headers['List-Unsubscribe']).toBeUndefined();
    const [stored] = await engine.listMessages(first.tenantId);
    expect(stored!.status).toBe('sent');
    expect(stored!.providerMessageId).toMatch(/^log-1-/);
  });

  it('rejects bad input with a readable message', async () => {
    const { engine, app } = await start();
    await expect(engine.sendEmail(app, { tenant: 'linden', to: 'not-an-email', subject: 'Hi', text: 'Hi' })).rejects.toMatchObject({
      code: 'invalid_request',
      status: 422,
    });
    await expect(engine.sendEmail(app, { tenant: 'linden', to: 'a@b.co', subject: 'Hi' })).rejects.toThrow('Give html, text or both.');
    await expect(engine.sendEmail(app, { tenant: 'nobody', to: 'a@b.co', subject: 'Hi', text: 'x' })).rejects.toMatchObject({
      code: 'tenant_not_found',
    });
  });

  it('refuses unknown API keys', async () => {
    const { engine } = await start();
    await expect(engine.authenticate('pk_live_nope')).rejects.toBeInstanceOf(PlatformError);
    await expect(engine.authenticate(undefined)).rejects.toMatchObject({ status: 401 });
  });

  it('only sends marketing to contacts who said yes, and adds one-click unsubscribe', async () => {
    const { engine, app, drain, transport } = await start();
    const blocked = await engine.sendEmail(app, { tenant: 'linden', stream: 'marketing', to: 'kofi@example.com', subject: 'Autumn', html: '<p>Hi</p>' });
    expect(blocked.status).toBe('suppressed');
    expect(blocked.error).toBe('no_marketing_consent');

    await engine.upsertContact(app, {
      tenant: 'linden',
      email: 'kofi@example.com',
      firstName: 'Kofi',
      consent: { marketing: 'granted', source: 'saleane:booking-form' },
    });
    const sent = await engine.sendEmail(app, { tenant: 'linden', stream: 'marketing', to: 'kofi@example.com', subject: 'Autumn', html: '<p>Hi</p>' });
    expect(sent.status).toBe('queued');
    await drain();
    const email = (transport as LogTransport).sent.at(-1)!;
    expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const url = email.headers['List-Unsubscribe']!.slice(1, -1);
    expect(url.startsWith('https://api.test/u/')).toBe(true);

    const result = await engine.unsubscribe(url.split('/u/')[1]!);
    expect(result).toEqual({ email: 'kofi@example.com', tenantName: 'Linden Studio' });

    const after = await engine.sendEmail(app, { tenant: 'linden', stream: 'marketing', to: 'kofi@example.com', subject: 'Again', html: '<p>Hi</p>' });
    expect(after.status).toBe('suppressed');
    const receipt = await engine.sendEmail(app, { tenant: 'linden', to: 'kofi@example.com', subject: 'Your receipt', text: 'Thanks' });
    expect(receipt.status).toBe('queued');

    await expect(engine.unsubscribe(`${sent.id}.forged`)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('puts a message back in the queue on a temporary failure and fails it on a permanent one', async () => {
    let mode: 'down' | 'reject' = 'down';
    const transport = {
      name: 'flaky',
      async send(_: OutgoingEmail): Promise<{ providerMessageId: string }> {
        if (mode === 'down') throw new Error('SES throttled');
        throw new PermanentSendError('Email address is not verified.');
      },
    };
    const { engine, app, db } = await start({ transport });
    const message = await engine.sendEmail(app, { tenant: 'linden', to: 'a@example.com', subject: 'Hi', text: 'Hi' });
    await expect(engine.processSend(message.id)).rejects.toThrow('SES throttled');
    let [row] = await db.select().from(messages).where(eq(messages.id, message.id));
    expect(row).toMatchObject({ status: 'queued', attempts: 1, error: 'SES throttled' });

    mode = 'reject';
    await engine.processSend(message.id);
    [row] = await db.select().from(messages).where(eq(messages.id, message.id));
    expect(row).toMatchObject({ status: 'failed', attempts: 2 });
  });
});

describe('SES events', () => {
  async function sentMessage(ctx: Awaited<ReturnType<typeof start>>, to = 'ama@example.com', tenant = 'linden') {
    const message = await ctx.engine.sendEmail(ctx.app, { tenant, to, subject: 'Hi', text: 'Hi' });
    await ctx.drain();
    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, message.id));
    return row!;
  }

  it('marks deliveries and never moves a bounced message back to delivered', async () => {
    const ctx = await start();
    const message = await sentMessage(ctx);
    await ctx.engine.ingestSesEvent(sesEvent('Bounce', message.providerMessageId!, { bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'ama@example.com', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }] } }));
    await ctx.engine.ingestSesEvent(sesEvent('Delivery', message.providerMessageId!, { delivery: { timestamp: '2026-10-11T09:00:05.000Z' } }));
    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, message.id));
    expect(row!.status).toBe('bounced');
  });

  it('suppresses a hard-bounced address for every tenant', async () => {
    const ctx = await start();
    await ctx.engine.upsertTenant(ctx.appId, 'harbour', { name: 'Harbour Spa' });
    const message = await sentMessage(ctx);
    await ctx.engine.ingestSesEvent(sesEvent('Bounce', message.providerMessageId!, { bounce: { bounceType: 'Permanent' } }));
    const other = await ctx.engine.sendEmail(ctx.app, { tenant: 'harbour', to: 'ama@example.com', subject: 'Hi', text: 'Hi' });
    expect(other).toMatchObject({ status: 'suppressed', error: 'hard_bounce' });
  });

  it('does not suppress after a soft bounce', async () => {
    const ctx = await start();
    const message = await sentMessage(ctx);
    await ctx.engine.ingestSesEvent(sesEvent('Bounce', message.providerMessageId!, { bounce: { bounceType: 'Transient' } }));
    expect(await ctx.db.select().from(suppressions)).toHaveLength(0);
  });

  it('stops marketing after a complaint but still allows reminders', async () => {
    const ctx = await start();
    await ctx.engine.upsertContact(ctx.app, { tenant: 'linden', email: 'ama@example.com', consent: { marketing: 'granted', source: 'test' } });
    const message = await sentMessage(ctx);
    const result = await ctx.engine.ingestSesEvent(sesEvent('Complaint', message.providerMessageId!, { complaint: { complaintFeedbackType: 'abuse' } }));
    expect(result).toMatchObject({ applied: true, type: 'complaint' });
    const marketing = await ctx.engine.sendEmail(ctx.app, { tenant: 'linden', stream: 'marketing', to: 'ama@example.com', subject: 'Offer', text: 'x' });
    expect(marketing.status).toBe('suppressed');
    const reminder = await ctx.engine.sendEmail(ctx.app, { tenant: 'linden', to: 'ama@example.com', subject: 'Reminder', text: 'x' });
    expect(reminder.status).toBe('queued');
  });

  it('ignores events for messages it never sent', async () => {
    const ctx = await start();
    expect(await ctx.engine.ingestSesEvent(sesEvent('Delivery', 'unknown-id'))).toMatchObject({ applied: false });
    expect(await ctx.engine.ingestSesEvent({ hello: 'world' })).toMatchObject({ applied: false });
  });

  it('reads SES records, including ones still inside an SNS envelope', () => {
    const record = sesEvent('Rendering Failure', 'ses-1', { failure: { errorMessage: 'Attribute missing' } });
    const parsed = parseSesEvent({ Type: 'Notification', Message: JSON.stringify(record) });
    expect(parsed).toMatchObject({ type: 'rendering_failure', providerMessageId: 'ses-1', detail: { error: 'Attribute missing' } });
    expect(parseSesEvent({ notificationType: 'Bounce', mail: { messageId: 'm', tags: { platform_message_id: ['msg_1'] } }, bounce: { bounceType: 'Permanent' } })).toMatchObject({
      type: 'bounce',
      permanent: true,
      platformMessageId: 'msg_1',
    });
  });
});

describe('webhooks', () => {
  it('posts signed events that verify with the Standard Webhooks library', async () => {
    const received: { headers: Record<string, string>; body: string }[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      received.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('ok');
    }) as unknown as typeof fetch;
    const ctx = await start({ fetch: fakeFetch });
    const { secret } = await ctx.engine.addWebhookEndpoint(ctx.appId, 'https://saleane.test/hooks/email', ['email.sent', 'email.bounced']);
    const message = await ctx.engine.sendEmail(ctx.app, { tenant: 'linden', to: 'ama@example.com', subject: 'Hi', text: 'Hi', tags: { booking: 'b_42' } });
    await ctx.drain();

    expect(received).toHaveLength(1);
    const payload = new Webhook(secret).verify(received[0]!.body, received[0]!.headers) as { type: string; data: Record<string, unknown> };
    expect(payload.type).toBe('email.sent');
    expect(payload.data).toMatchObject({ tenant: 'linden', emailId: message.id, tags: { booking: 'b_42' } });
  });

  it('retries a failed delivery through the queue', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response('nope', { status: calls === 1 ? 500 : 200 });
    }) as unknown as typeof fetch;
    const ctx = await start({ fetch: fakeFetch });
    await ctx.engine.addWebhookEndpoint(ctx.appId, 'https://saleane.test/hooks/email');
    await ctx.engine.sendEmail(ctx.app, { tenant: 'linden', to: 'ama@example.com', subject: 'Hi', text: 'Hi' });
    await ctx.engine.processSend((ctx.queue.jobs.shift()!.data as { messageId: string }).messageId);
    const job = ctx.queue.jobs.shift()!;
    const deliveryId = (job.data as { deliveryId: string }).deliveryId;
    await expect(ctx.engine.processWebhook(deliveryId)).rejects.toThrow('HTTP 500');
    await ctx.engine.processWebhook(deliveryId);
    expect(calls).toBe(2);
  });
});

describe('SNS signatures', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certUrl = 'https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-test.pem';
  primeSnsCertificate(certUrl, publicKey.export({ type: 'spki', format: 'pem' }).toString());

  function signed(overrides: Partial<SnsMessage> = {}): SnsMessage {
    const m: SnsMessage = {
      Type: 'Notification',
      MessageId: 'abc',
      TopicArn: 'arn:aws:sns:eu-west-2:123:ses-events',
      Message: '{"eventType":"Delivery"}',
      Timestamp: '2026-10-11T09:00:00.000Z',
      SignatureVersion: '2',
      Signature: '',
      SigningCertURL: certUrl,
      ...overrides,
    };
    const text = `Message\n${m.Message}\nMessageId\n${m.MessageId}\nTimestamp\n${m.Timestamp}\nTopicArn\n${m.TopicArn}\nType\n${m.Type}\n`;
    m.Signature = createSign('RSA-SHA256').update(text).sign(privateKey, 'base64');
    return m;
  }

  it('accepts a correctly signed notification', async () => {
    expect(await verifySnsMessage(signed())).toBe(true);
  });

  it('rejects tampering and certificates from anywhere but SNS', async () => {
    expect(await verifySnsMessage({ ...signed(), Message: '{"eventType":"Bounce"}' })).toBe(false);
    expect(await verifySnsMessage(signed({ SigningCertURL: 'https://evil.example.com/cert.pem' }))).toBe(false);
    expect(await verifySnsMessage(signed({ SigningCertURL: 'http://sns.eu-west-2.amazonaws.com/x.pem' }))).toBe(false);
  });
});
