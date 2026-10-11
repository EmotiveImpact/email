import type { LogTransport } from '@platform/engine';
import { setup } from '@platform/engine/testing';
import { Webhook } from 'standardwebhooks';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(options: { verifySns?: boolean; fetch?: typeof fetch } = {}) {
  const ctx = await setup({ fetch: options.fetch });
  close = ctx.close;
  const api = createApi({
    engine: ctx.engine,
    db: ctx.db,
    webOrigin: 'http://localhost:5173',
    devDashboardAppId: ctx.appId,
    verifySns: async () => options.verifySns ?? true,
    fetch: options.fetch,
  });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    api.request(path, {
      method,
      headers: { authorization: `Bearer ${ctx.key}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { ...ctx, api, call };
}

describe('/v1', () => {
  it('needs a valid API key', async () => {
    const { call } = await start();
    const response = await call('POST', '/v1/emails', {}, { authorization: 'Bearer nope' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorised' } });
  });

  it('creates tenants, syncs contacts, records events and sends email', async () => {
    const { call, drain } = await start();
    let response = await call('PUT', '/v1/tenants/harbour', { name: 'Harbour Spa', fromEmail: 'hello@harbour.test', brand: { accent: '#4F7F67' } });
    expect(await response.json()).toMatchObject({ id: 'harbour', name: 'Harbour Spa', brand: { accent: '#4F7F67' } });

    response = await call('PUT', '/v1/contacts', { tenant: 'harbour', email: 'ama@example.com', firstName: 'Ama', consent: { marketing: 'granted', source: 'saleane:booking-form' } });
    expect(await response.json()).toMatchObject({ email: 'ama@example.com', marketingConsent: 'granted' });

    response = await call('POST', '/v1/events', { tenant: 'harbour', name: 'booking.created', email: 'ama@example.com', properties: { treatment: 'Facial' } });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ name: 'booking.created', matchedContact: true });

    response = await call('POST', '/v1/emails', { tenant: 'harbour', to: 'ama@example.com', subject: 'See you Thursday', text: 'Hi Ama' }, { 'idempotency-key': 'booking-1-reminder' });
    expect(response.status).toBe(202);
    const sent = (await response.json()) as { id: string; status: string };
    expect(sent.status).toBe('queued');

    const repeat = (await (await call('POST', '/v1/emails', { tenant: 'harbour', to: 'ama@example.com', subject: 'x', text: 'x' }, { 'idempotency-key': 'booking-1-reminder' })).json()) as { id: string };
    expect(repeat.id).toBe(sent.id);

    await drain();
    const fetched = await (await call('GET', `/v1/emails/${sent.id}`)).json();
    expect(fetched).toMatchObject({ id: sent.id, status: 'sent' });
  });

  it('explains validation errors', async () => {
    const { call } = await start();
    const response = await call('POST', '/v1/emails', { tenant: 'linden', to: 'nope', subject: 'Hi', text: 'x' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request', message: expect.stringContaining('to') } });
    const bad = await call('POST', '/v1/emails', 'not json');
    expect(bad.status).toBe(400);
  });

  it('does not show one app another app’s email', async () => {
    const { call, engine } = await start();
    const { appId: other } = await engine.createAccountWithApp({ account: 'Other', app: 'Other' });
    const { key } = await engine.createApiKey(other, 'other');
    const sent = (await (await call('POST', '/v1/emails', { tenant: 'linden', to: 'a@example.com', subject: 'Hi', text: 'x' })).json()) as { id: string };
    const response = await call('GET', `/v1/emails/${sent.id}`, undefined, { authorization: `Bearer ${key}` });
    expect(response.status).toBe(404);
  });

  it('registers a webhook endpoint and returns its secret once', async () => {
    const received: { headers: Record<string, string>; body: string }[] = [];
    const fakeFetch = (async (_: string, init: RequestInit) => {
      received.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('ok');
    }) as unknown as typeof fetch;
    const { call, drain } = await start({ fetch: fakeFetch });
    const created = (await (await call('POST', '/v1/webhooks', { url: 'https://saleane.test/hooks', events: ['email.sent', 'not.real'] })).json()) as { secret: string; events: string[] };
    expect(created.events).toEqual(['email.sent']);
    await call('POST', '/v1/emails', { tenant: 'linden', to: 'a@example.com', subject: 'Hi', text: 'x' });
    await drain();
    expect(new Webhook(created.secret).verify(received[0]!.body, received[0]!.headers)).toMatchObject({ type: 'email.sent' });
  });
});

describe('/ses/events', () => {
  const notification = (message: unknown) =>
    JSON.stringify({ Type: 'Notification', MessageId: 'n1', TopicArn: 'arn', Message: JSON.stringify(message), Timestamp: '', SignatureVersion: '2', Signature: 'x', SigningCertURL: 'https://sns.eu-west-2.amazonaws.com/c.pem' });

  it('applies verified events and refuses unverified ones', async () => {
    const ctx = await start();
    const sent = (await (await ctx.call('POST', '/v1/emails', { tenant: 'linden', to: 'a@example.com', subject: 'Hi', text: 'x' })).json()) as { id: string };
    await ctx.drain();
    const fetched = await ctx.engine.listMessages((await ctx.engine.getTenant(ctx.appId, 'linden')).id);
    const providerId = fetched[0]!.providerMessageId!;

    const response = await ctx.api.request('/ses/events', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: notification({ eventType: 'Delivery', mail: { messageId: providerId }, delivery: {} }) });
    expect(await response.json()).toMatchObject({ applied: true, messageId: sent.id, type: 'delivery' });

    const blocked = await start({ verifySns: false });
    const refused = await blocked.api.request('/ses/events', { method: 'POST', body: notification({}) });
    expect(refused.status).toBe(403);
  });

  it('confirms the SNS subscription only for an SNS URL', async () => {
    const visited: string[] = [];
    const fakeFetch = (async (url: string) => {
      visited.push(url);
      return new Response('ok');
    }) as unknown as typeof fetch;
    const { api } = await start({ fetch: fakeFetch });
    const base = { Type: 'SubscriptionConfirmation', MessageId: 'm', TopicArn: 'arn', Message: '', Timestamp: '', SignatureVersion: '2', Signature: 'x', SigningCertURL: '' };
    let response = await api.request('/ses/events', { method: 'POST', body: JSON.stringify({ ...base, SubscribeURL: 'https://evil.example.com/confirm' }) });
    expect(response.status).toBe(400);
    response = await api.request('/ses/events', { method: 'POST', body: JSON.stringify({ ...base, SubscribeURL: 'https://sns.eu-west-2.amazonaws.com/?Action=ConfirmSubscription' }) });
    expect(await response.json()).toEqual({ confirmed: true });
    expect(visited).toEqual(['https://sns.eu-west-2.amazonaws.com/?Action=ConfirmSubscription']);
  });
});

describe('unsubscribe page', () => {
  it('asks before unsubscribing, then unsubscribes on POST', async () => {
    const { call, drain, api, transport } = await start();
    await call('PUT', '/v1/contacts', { tenant: 'linden', email: 'kofi@example.com', consent: { marketing: 'granted', source: 'test' } });
    await call('POST', '/v1/emails', { tenant: 'linden', stream: 'marketing', to: 'kofi@example.com', subject: 'News', html: '<p>x</p>' });
    await drain();
    const link = (transport as LogTransport).sent[0]!.headers['List-Unsubscribe']!.slice(1, -1);
    const path = new URL(link).pathname;

    const get = await api.request(path);
    expect(await get.text()).toContain('Stop these emails?');
    const post = await api.request(path, { method: 'POST' });
    expect(await post.text()).toContain('will not get news from Linden Studio');
    const again = (await (await call('POST', '/v1/emails', { tenant: 'linden', stream: 'marketing', to: 'kofi@example.com', subject: 'More news', html: '<p>x</p>' })).json()) as { status: string; reason: string };
    expect(again).toMatchObject({ status: 'suppressed', reason: 'unsubscribe' });
  });
});

describe('/app (local dashboard)', () => {
  it('lists tenants, shows activity and saves the look', async () => {
    const { api, call, drain } = await start();
    await call('POST', '/v1/emails', { tenant: 'linden', to: 'a@example.com', subject: 'Hi', text: 'x' });
    await drain();
    expect(await (await api.request('/app/tenants')).json()).toMatchObject([{ id: 'linden', name: 'Linden Studio' }]);
    const activity = (await (await api.request('/app/tenants/linden/activity')).json()) as {
      stats: Record<string, number>;
      daily: { day: string; total: number }[];
      messages: unknown[];
    };
    expect(activity.stats.sent).toBe(1);
    expect(activity.daily).toHaveLength(31);
    expect(activity.daily.at(-1)).toMatchObject({ day: new Date().toISOString().slice(0, 10), total: 1 });
    expect(activity.messages).toHaveLength(1);
    await call('POST', '/v1/emails', { tenant: 'linden', stream: 'marketing', to: 'nobody@example.com', subject: 'News', html: '<p>x</p>' });
    const held = (await (await api.request('/app/tenants/linden/messages?show=held')).json()) as { to: string; reason: string }[];
    expect(held).toEqual([expect.objectContaining({ to: 'nobody@example.com', reason: 'no_marketing_consent' })]);
    expect((await api.request('/app/tenants/linden/messages?show=nope')).status).toBe(422);
    const saved = await api.request('/app/tenants/linden/brand', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accent: '#4B4FD8', rail: 'light' }) });
    expect(await saved.json()).toMatchObject({ brand: { accent: '#4B4FD8', rail: 'light' }, fromEmail: 'news@linden.test' });
  });
});
