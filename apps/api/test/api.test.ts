import type { LogTransport } from '@platform/engine';
import { setup } from '@platform/engine/testing';
import { Webhook } from 'standardwebhooks';
import { afterEach, describe, expect, it } from 'vitest';
import { members, newId } from '@platform/db';
import { createApi } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';

const WEB = 'http://localhost:5173';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(options: { verifySns?: boolean; fetch?: typeof fetch } = {}) {
  const ctx = await setup({ fetch: options.fetch });
  close = ctx.close;
  const auth = createAuth({ db: ctx.db, engine: ctx.engine, secret: 'test-secret-that-is-long-enough-1234', baseURL: WEB, webOrigin: WEB });
  const api = createApi({
    engine: ctx.engine,
    db: ctx.db,
    webOrigin: WEB,
    auth,
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

/** Signs up a person and returns a function that calls /app as them. */
async function signedIn(ctx: Awaited<ReturnType<typeof start>>, options: { joinAccount?: boolean; email?: string } = {}) {
  const response = await ctx.api.request('/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB },
    body: JSON.stringify({ name: 'Edem', email: options.email ?? 'edem@test.dev', password: 'a-long-enough-password' }),
  });
  expect(response.status).toBe(200);
  const { user } = (await response.json()) as { user: { id: string } };
  if (options.joinAccount !== false) await ctx.db.insert(members).values({ id: newId('mem'), organizationId: ctx.accountId, userId: user.id, role: 'owner' });
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return (method: string, path: string, body?: unknown) =>
    ctx.api.request(path, {
      method,
      headers: { cookie, origin: WEB, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

describe('/app (the web app)', () => {
  it('needs a signed-in person', async () => {
    const { api } = await start();
    const response = await api.request('/app/tenants');
    expect(response.status).toBe(401);
  });

  it('lists businesses, shows activity and saves the look', async () => {
    const ctx = await start();
    const app = await signedIn(ctx);
    await ctx.call('POST', '/v1/emails', { tenant: 'linden', to: 'a@example.com', subject: 'Hi', text: 'x' });
    await ctx.drain();
    const tenants = (await (await app('GET', '/app/tenants')).json()) as { id: string; name: string; app: string }[];
    expect(tenants).toMatchObject([{ id: ctx.tenant.id, name: 'Linden Studio', app: 'Saleane' }]);
    const base = `/app/tenants/${ctx.tenant.id}`;
    const activity = (await (await app('GET', `${base}/activity`)).json()) as {
      stats: Record<string, number>;
      daily: { day: string; total: number }[];
      messages: unknown[];
    };
    expect(activity.stats.sent).toBe(1);
    expect(activity.daily).toHaveLength(31);
    expect(activity.daily.at(-1)).toMatchObject({ day: new Date().toISOString().slice(0, 10), total: 1 });
    expect(activity.messages).toHaveLength(1);

    await ctx.call('POST', '/v1/emails', { tenant: 'linden', stream: 'marketing', to: 'nobody@example.com', subject: 'News', html: '<p>x</p>' });
    const held = (await (await app('GET', `${base}/messages?show=held`)).json()) as { to: string; reason: string }[];
    expect(held).toEqual([expect.objectContaining({ to: 'nobody@example.com', reason: 'no_marketing_consent' })]);
    expect((await app('GET', `${base}/messages?show=nope`)).status).toBe(422);

    const saved = await app('PUT', `${base}/brand`, { accent: '#4B4FD8', rail: 'light' });
    expect(await saved.json()).toMatchObject({ brand: { accent: '#4B4FD8', rail: 'light' }, fromEmail: 'news@linden.test' });
  });

  it('keeps other accounts’ businesses out of reach', async () => {
    const ctx = await start();
    const stranger = await signedIn(ctx, { joinAccount: false, email: 'stranger@test.dev' });
    expect((await stranger('GET', '/app/tenants')).status).toBe(403);
    expect(await (await stranger('GET', '/app/me')).json()).toMatchObject({ accountId: null, accounts: [] });

    const created = await stranger('POST', '/app/accounts', { name: 'Harbour Spa' });
    expect(created.status).toBe(201);
    expect(await (await stranger('GET', '/app/tenants')).json()).toEqual([]);
    expect((await stranger('GET', `/app/tenants/${ctx.tenant.id}/activity`)).status).toBe(404);

    const business = (await (await stranger('POST', '/app/tenants', { name: 'Harbour Spa', fromEmail: 'hi@harbour.test' })).json()) as { id: string; app: string };
    expect(business.app).toBe('Direct');
    const segments = (await (await stranger('GET', `/app/tenants/${business.id}/segments`)).json()) as { name: string }[];
    expect(segments.map((s) => s.name)).toContain('Due for a visit');
  });

  it('manages contacts and segments', async () => {
    const ctx = await start();
    const app = await signedIn(ctx);
    const base = `/app/tenants/${ctx.tenant.id}`;
    await ctx.call('PUT', '/v1/contacts', { tenant: 'linden', email: 'ama@example.com', firstName: 'Ama', attributes: { treatment: 'Facial' }, consent: { marketing: 'granted', source: 'test' } });
    await ctx.call('POST', '/v1/events', { tenant: 'linden', name: 'booking.created', email: 'ama@example.com' });
    const added = await app('POST', `${base}/contacts`, { email: 'Kofi@Example.com', firstName: 'Kofi', consent: true });
    expect(await added.json()).toMatchObject({ email: 'kofi@example.com' });

    const list = (await (await app('GET', `${base}/contacts?search=kofi`)).json()) as { total: number; contacts: { id: string; marketingConsent: string }[] };
    expect(list).toMatchObject({ total: 1, contacts: [{ marketingConsent: 'granted' }] });
    const detail = (await (await app('GET', `${base}/contacts/${list.contacts[0]!.id}`)).json()) as { consents: { source: string }[] };
    expect(detail.consents[0]!.source).toBe('added-by:edem@test.dev');

    const definition = { match: 'all', conditions: [{ type: 'attribute', key: 'treatment', op: 'equals', value: 'facial' }] };
    expect(await (await app('POST', `${base}/segments/preview`, { definition })).json()).toMatchObject({ size: 1, sample: [{ firstName: 'Ama' }] });
    const segment = (await (await app('POST', `${base}/segments`, { name: 'Facial clients', definition })).json()) as { id: string };
    const inSegment = (await (await app('GET', `${base}/contacts?segment=${segment.id}`)).json()) as { total: number };
    expect(inSegment.total).toBe(1);
    expect(await (await app('GET', `${base}/vocabulary`)).json()).toEqual({ events: ['booking.created'], attributes: ['treatment'] });
    expect((await app('POST', `${base}/segments/preview`, { definition: { conditions: [{ type: 'attribute', key: 'x', op: 'equals' }] } })).status).toBe(422);
    expect((await app('DELETE', `${base}/segments/${segment.id}`)).status).toBe(204);
  });

  it('writes, checks, tests and sends a campaign', async () => {
    const ctx = await start();
    const app = await signedIn(ctx);
    const base = `/app/tenants/${ctx.tenant.id}`;
    await ctx.call('PUT', '/v1/contacts', { tenant: 'linden', email: 'ama@example.com', firstName: 'Ama', consent: { marketing: 'granted', source: 'test' } });
    await ctx.call('PUT', '/v1/contacts', { tenant: 'linden', email: 'kofi@example.com', firstName: 'Kofi' });

    const draft = (await (await app('POST', `${base}/campaigns`, { name: 'Thursday' })).json()) as { id: string; content: { blocks: { type: string }[] } };
    expect(draft.content.blocks.length).toBeGreaterThan(0);
    const detail = (await (await app('GET', `${base}/campaigns/${draft.id}`)).json()) as { problems: string[]; audience: { eligible: number } };
    expect(detail.problems[0]).toBe('Add a subject line.');
    expect(detail.audience.eligible).toBe(1);
    expect((await app('POST', `${base}/campaigns/${draft.id}/schedule`, {})).status).toBe(422);

    const content = { preview: 'Space', blocks: [{ id: 'h', type: 'heading', text: 'Hi {{first_name}}' }] };
    const { html } = (await (await app('POST', `${base}/campaigns/preview`, { content })).json()) as { html: string };
    expect(html).toContain('Hi Ama');
    const saved = (await (await app('PUT', `${base}/campaigns/${draft.id}`, { subject: 'This Thursday', content })).json()) as { problems: string[] };
    expect(saved.problems).toEqual([]);

    expect(await (await app('POST', `${base}/campaigns/${draft.id}/test`, {})).json()).toEqual({ to: 'edem@test.dev' });
    const sent = (await (await app('POST', `${base}/campaigns/${draft.id}/schedule`, {})).json()) as { status: string };
    expect(sent.status).toBe('scheduled');
    await ctx.drain();
    const list = (await (await app('GET', `${base}/campaigns`)).json()) as { status: string; recipients: number; stats: { total: number } }[];
    expect(list[0]).toMatchObject({ status: 'sent', recipients: 1, stats: { total: 1 } });
    const recipients = (ctx.transport as LogTransport).sent.map((m) => m.to).sort();
    expect(recipients).toEqual(['ama@example.com', 'edem@test.dev']);
    expect((await app('DELETE', `${base}/campaigns/${draft.id}`)).status).toBe(409);
  });
});

describe('embedded studio', () => {
  const HOST = 'https://app.saleane.test';

  async function launch(ctx: Awaited<ReturnType<typeof start>>) {
    expect((await ctx.call('PUT', '/v1/studio/origins', { origins: [`${HOST}/settings`, 'http://localhost:3000'] })).status).toBe(200);
    const response = await ctx.call('POST', '/v1/studio/sessions', {
      tenant: 'linden',
      origin: HOST,
      user: { id: 'staff-7', name: 'Maya', email: 'maya@linden.test' },
      theme: { accent: '#5E7D63', headingFont: 'serif', canvas: '#F7F3EA' },
    });
    expect(response.status).toBe(201);
    const { url } = (await response.json()) as { url: string };
    expect(url.startsWith(`${WEB}/embed?page=campaigns#token=stl_`)).toBe(true);
    return url.split('#token=')[1]!;
  }

  const exchange = (ctx: Awaited<ReturnType<typeof start>>, token: string) =>
    ctx.api.request('/app/studio/exchange', { method: 'POST', headers: { 'content-type': 'application/json', origin: WEB }, body: JSON.stringify({ token }) });

  it('only opens for origins the app has allowed', async () => {
    const ctx = await start();
    const refused = await ctx.call('POST', '/v1/studio/sessions', { tenant: 'linden', origin: HOST, user: { id: 'x' } });
    expect(refused.status).toBe(403);
    expect((await ctx.call('PUT', '/v1/studio/origins', { origins: ['http://evil.test'] })).status).toBe(422);
  });

  it('swaps a launch token once for a session that reaches one business', async () => {
    const ctx = await start();
    const token = await launch(ctx);
    const swapped = await exchange(ctx, token);
    expect(swapped.status).toBe(200);
    const session = (await swapped.json()) as { sessionToken: string; tenantId: string; theme: { canvas: string } };
    expect(session).toMatchObject({ tenantId: ctx.tenant.id, theme: { canvas: '#F7F3EA' } });
    expect((await exchange(ctx, token)).status).toBe(401);

    const studio = (method: string, path: string, body?: unknown) =>
      ctx.api.request(path, {
        method,
        headers: { authorization: `Studio ${session.sessionToken}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const me = (await (await studio('GET', '/app/me')).json()) as { user: { name: string }; studio: { tenantId: string } };
    expect(me).toMatchObject({ user: { name: 'Maya' }, studio: { tenantId: ctx.tenant.id } });
    expect(((await (await studio('GET', '/app/tenants')).json()) as unknown[]).length).toBe(1);

    const draft = (await (await studio('POST', `/app/tenants/${ctx.tenant.id}/campaigns`, { name: 'From Saleane' })).json()) as { id: string; createdBy: string };
    expect(draft.createdBy).toMatch(/:staff-7$/);
    expect(await (await studio('POST', `/app/tenants/${ctx.tenant.id}/campaigns/${draft.id}/test`, {})).json()).toEqual({ to: 'maya@linden.test' });

    // Other businesses in the same account, and account settings, stay out of reach.
    const other = await ctx.engine.upsertTenant(ctx.appId, 'harbour', { name: 'Harbour Spa' });
    expect((await studio('GET', `/app/tenants/${other.id}/campaigns`)).status).toBe(404);
    expect((await studio('POST', '/app/accounts', { name: 'Mine' })).status).toBe(403);
    expect((await studio('PUT', `/app/tenants/${ctx.tenant.id}/brand`, { accent: '#000000' })).status).toBe(403);
    expect((await studio('POST', '/app/tenants', { name: 'New' })).status).toBe(403);

    await ctx.engine.endStudioSession(session.sessionToken);
    expect((await studio('GET', '/app/me')).status).toBe(401);
  });
});

describe('sending domains', () => {
  it('sets up a domain from the app and through the API', async () => {
    const ctx = await start();
    const app = await signedIn(ctx);
    const base = `/app/tenants/${ctx.tenant.id}`;
    const added = (await (await app('POST', `${base}/domains`, { domain: 'lindenstudio.co.uk', localPart: 'News' })).json()) as { id: string; status: string; records: unknown[]; dmarcRecord: { name: string } };
    expect(added).toMatchObject({ status: 'pending', dmarcRecord: { name: '_dmarc.lindenstudio.co.uk' } });
    expect(added.records).toHaveLength(3);
    const sending = (await (await app('GET', `${base}/sending`)).json()) as { domains: unknown[]; sender: { from: string }; reputation: { sent: number } };
    expect(sending.domains).toHaveLength(1);
    // Local work sends from any address; production only from verified domains.
    expect(sending.sender.from).toBe('Linden Studio <news@lindenstudio.co.uk>');
    expect((await app('POST', `${base}/domains/${added.id}/check`)).status).toBe(200);

    const viaApi = await ctx.call('POST', '/v1/tenants/linden/domains', { domain: 'linden.test' });
    expect(viaApi.status).toBe(201);
    const listed = (await (await ctx.call('GET', '/v1/tenants/linden/domains')).json()) as { domain: string; status: string }[];
    expect(listed.map((d) => d.domain).sort()).toEqual(['linden.test', 'lindenstudio.co.uk']);
    const id = ((await viaApi.json()) as { id: string }).id;
    expect(await (await ctx.call('POST', `/v1/tenants/linden/domains/${id}/check`)).json()).toMatchObject({ status: 'verified' });
    expect((await ctx.call('DELETE', `/v1/tenants/linden/domains/${id}`)).status).toBe(204);
  });
});

