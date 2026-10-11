import { encodePng, type LogTransport } from '@platform/engine';
import { fakePhorest, fakeSquare, PHOREST_TEST_LOGIN, setup, SQUARE_TEST_CONFIG } from '@platform/engine/testing';
import { Webhook } from 'standardwebhooks';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, members, messages, newId } from '@platform/db';
import { createApi } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';

const WEB = 'http://localhost:5173';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

type Mail = { to: string; subject: string; html: string; text: string };

async function start(options: { verifySns?: boolean; fetch?: typeof fetch; mail?: (m: Mail) => Promise<void>; square?: boolean } = {}) {
  const ctx = await setup({ fetch: options.fetch, square: options.square ? SQUARE_TEST_CONFIG : undefined });
  close = ctx.close;
  const auth = createAuth({ db: ctx.db, engine: ctx.engine, secret: 'test-secret-that-is-long-enough-1234', baseURL: WEB, webOrigin: WEB, mail: options.mail });
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

    const listed = (await (await call('GET', '/v1/webhooks')).json()) as { id: string; url: string }[];
    expect(listed).toEqual([expect.objectContaining({ url: 'https://saleane.test/hooks' })]);
    expect((await call('DELETE', `/v1/webhooks/${listed[0]!.id}`)).status).toBe(204);
    expect(await (await call('GET', '/v1/webhooks')).json()).toEqual([]);
    expect((await call('POST', '/v1/webhooks', { url: 'http://saleane.test/hooks' })).status).toBe(422);
    expect((await call('POST', '/v1/webhooks', { url: 'https://169.254.169.254/latest' })).status).toBe(422);
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
    const asked = await get.text();
    expect(asked).toContain('Stop emails from Linden Studio?');
    expect(asked).toContain('kofi@example.com');
    const broken = await api.request(`${path.slice(0, -4)}xxxx`);
    expect(broken.status).toBe(404);
    expect(await broken.text()).toContain('This link is not valid');
    const post = await api.request(path, { method: 'POST' });
    expect(await post.text()).toContain('will not get news from Linden Studio');
    const again = (await (await call('POST', '/v1/emails', { tenant: 'linden', stream: 'marketing', to: 'kofi@example.com', subject: 'More news', html: '<p>x</p>' })).json()) as { status: string; reason: string };
    expect(again).toMatchObject({ status: 'suppressed', reason: 'unsubscribe' });
  });
});

/** Signs up a person and returns a function that calls /app as them. */
async function signedIn(ctx: Awaited<ReturnType<typeof start>>, options: { joinAccount?: boolean; email?: string; role?: string } = {}) {
  const response = await ctx.api.request('/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB },
    body: JSON.stringify({ name: 'Edem', email: options.email ?? 'edem@test.dev', password: 'a-long-enough-password' }),
  });
  expect(response.status).toBe(200);
  const { user } = (await response.json()) as { user: { id: string } };
  if (options.joinAccount !== false) await ctx.db.insert(members).values({ id: newId('mem'), organizationId: ctx.accountId, userId: user.id, role: options.role ?? 'owner' });
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return (method: string, path: string, body?: unknown) =>
    ctx.api.request(path, {
      method,
      headers: { cookie, origin: WEB, 'content-type': body instanceof Uint8Array ? 'image/png' : 'application/json' },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
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
    expect(detail.problems[0]).toMatch(/button needs a link/);
    expect(detail.audience.eligible).toBe(1);
    expect((await app('POST', `${base}/campaigns/${draft.id}/schedule`, {})).status).toBe(422);

    const content = { preview: 'Space', blocks: [{ id: 'h', type: 'heading', text: 'Hi {{first_name}}' }] };
    const { html } = (await (await app('POST', `${base}/campaigns/preview`, { content })).json()) as { html: string };
    expect(html).toContain('Hi Ama');
    const saved = (await (await app('PUT', `${base}/campaigns/${draft.id}`, { subject: 'This Thursday', content })).json()) as { problems: string[] };
    expect(saved.problems).toEqual([]);

    expect(await (await app('POST', `${base}/campaigns/${draft.id}/test`, {})).json()).toEqual({ to: 'edem@test.dev' });
    // Tests only go to the team, never to an address typed in.
    expect((await app('POST', `${base}/campaigns/${draft.id}/test`, { to: 'stranger@example.com' })).status).toBe(403);
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


describe('the diary and flows', () => {
  it('takes bookings and free time, shows the week, and runs a flow from the app', async () => {
    const ctx = await start();
    const app = await signedIn(ctx);
    const base = `/app/tenants/${ctx.tenant.id}`;
    const at = (days: number, hour = 10) => {
      const d = new Date(Date.now() + days * 86_400_000);
      d.setUTCHours(hour, 0, 0, 0);
      return d.toISOString();
    };
    await ctx.call('PUT', '/v1/contacts', { tenant: 'linden', email: 'ama@example.com', firstName: 'Ama', consent: { marketing: 'granted', source: 'test' } });
    for (const [i, day] of [-89, -61, -33].entries()) {
      const booked = await ctx.call('PUT', '/v1/appointments', { tenant: 'linden', id: `a${i}`, email: 'ama@example.com', startsAt: at(day), service: 'Balayage', price: 9500, status: 'completed' });
      expect(booked.status).toBe(200);
    }
    expect((await ctx.call('PUT', '/v1/appointments', { tenant: 'linden', id: 'x', startsAt: at(1) })).status).toBe(422);
    const free = await ctx.call('PUT', '/v1/availability', { tenant: 'linden', from: at(0, 0), to: at(7, 0), slots: [{ startsAt: at(2), endsAt: at(2, 11) }] });
    expect(await free.json()).toEqual({ slots: 1 });

    const diary = (await (await app('GET', `${base}/diary`)).json()) as { connected: boolean; days: { open: number }[]; dueCount: number; due: { contact: { email: string } }[] };
    expect(diary).toMatchObject({ connected: true, dueCount: 1, due: [{ contact: { email: 'ama@example.com' } }] });
    expect(diary.days).toHaveLength(7);

    const overview = (await (await app('GET', `${base}/overview?days=7`)).json()) as { days: number; week: { parts: string[] }; dueCount: number; opportunities: { kind: string }[] };
    expect(overview).toMatchObject({ days: 7, dueCount: 1, week: { parts: ['Morning', 'Midday', 'Afternoon', 'Evening'] } });
    expect(overview.opportunities.map((o) => o.kind)).toContain('rebook');
    expect((await app('GET', `${base}/overview?days=12`)).status).toBe(422);

    const flows = (await (await app('GET', `${base}/flows`)).json()) as { id: string; kind: string; live: boolean; problems: string[] }[];
    expect(flows.map((f) => f.kind)).toEqual(['welcome', 'rebook', 'fill_slots', 'winback', 'review', 'birthday']);
    const rebook = flows.find((f) => f.kind === 'rebook')!;
    expect(rebook.problems[0]).toMatch(/booking link/);
    expect((await app('PUT', `${base}/flows/${rebook.id}`, { live: true })).status).toBe(422);

    await app('PUT', `${base}/brand`, { bookingUrl: 'https://linden.test/book', timezone: 'Europe/London' });
    const live = (await (await app('PUT', `${base}/flows/${rebook.id}`, { live: true, settings: { graceDays: 2 } })).json()) as { live: boolean; waiting: number; settings: Record<string, number> };
    expect(live).toMatchObject({ live: true, waiting: 1, settings: { graceDays: 2 } });
    const preview = (await (await app('POST', `${base}/flows/${rebook.id}/preview`, {})).json()) as { html: string };
    expect(preview.html).toContain('https://linden.test/book?at=');

    await ctx.engine.runFlows(ctx.tenant.id, new Date(), { ignoreHours: true });
    await ctx.drain();
    const contact = (await (await app('GET', `${base}/contacts?search=ama`)).json()) as { contacts: { id: string }[] };
    const detail = (await (await app('GET', `${base}/contacts/${contact.contacts[0]!.id}`)).json()) as { rhythm: { gapDays: number }; appointments: unknown[]; messages: { subject: string }[] };
    expect(detail).toMatchObject({ rhythm: { gapDays: 28 }, messages: [{ subject: 'Time for your next Balayage?' }] });
    expect(detail.appointments).toHaveLength(3);

    const batch = await ctx.call('POST', '/v1/appointments/batch', {
      tenant: 'linden',
      appointments: [
        { id: 'b1', email: 'kofi@example.com', startsAt: at(-40), status: 'completed' },
        { id: 'b2', startsAt: at(-20) },
        { id: 'b3', email: 'kofi@example.com', startsAt: at(-12), status: 'completed' },
      ],
    });
    expect(await batch.json()).toMatchObject({ saved: 2, errors: [{ index: 1 }] });

    const erased = await ctx.call('POST', '/v1/contacts/erase', { tenant: 'linden', email: 'ama@example.com' });
    expect(await erased.json()).toEqual({ erased: true });
    expect((await app('GET', `${base}/contacts/${contact.contacts[0]!.id}`)).status).toBe(404);
    const sent = await ctx.db.select().from(messages).where(eq(messages.tenantId, ctx.tenant.id));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((m) => /^erased\+.+@erased\.invalid$/.test(m.to) && m.html === null)).toBe(true);
    expect(await (await ctx.call('POST', '/v1/contacts/erase', { tenant: 'linden', email: 'ama@example.com' })).json()).toEqual({ erased: false });
    expect((await ctx.call('POST', '/v1/contacts/erase', { tenant: 'linden' })).status).toBe(422);
  });
});

describe('pictures', () => {
  it('uploads, generates and saves designs, and serves the files publicly', async () => {
    const ctx = await start();
    const app = await signedIn(ctx);
    const base = `/app/tenants/${ctx.tenant.id}`;
    const png = encodePng(8, 4, new Uint8Array(8 * 4 * 3).fill(120));

    const uploaded = await app('POST', `${base}/assets?name=salon.png`, png);
    expect(uploaded.status).toBe(201);
    const asset = (await uploaded.json()) as { id: string; url: string; name: string };
    expect(asset.name).toBe('salon');

    const file = await ctx.api.request(new URL(asset.url).pathname);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('cache-control')).toContain('immutable');
    expect((await ctx.api.request('/a/ast_nope-00000000.png')).status).toBe(404);

    expect((await app('POST', `${base}/assets`, new Uint8Array(6 * 1024 * 1024))).status).toBe(413);

    const generated = await app('POST', `${base}/assets/generate`, { prompt: 'A chair by a window', count: 1 });
    expect(generated.status).toBe(201);
    const design = { width: 600, height: 300, background: '#2D2470', layers: [] };
    const saved = await app('POST', `${base}/designs`, { name: 'Header', design, png: Buffer.from(png).toString('base64') });
    expect(saved.status).toBe(201);

    const library = (await (await app('GET', `${base}/assets`)).json()) as { assets: { kind: string }[]; images: { provider: string; left: number } };
    expect(library.assets.map((a) => a.kind).sort()).toEqual(['design', 'generated', 'upload']);
    expect(library.images).toMatchObject({ provider: 'sample', left: 39 });
    expect((await (await app('GET', `${base}/assets?kind=design`)).json()) as { assets: unknown[] }).toMatchObject({ assets: [{ kind: 'design' }] });

    expect((await app('DELETE', `${base}/assets/${asset.id}`)).status).toBe(204);
    expect((await ctx.api.request(new URL(asset.url).pathname)).status).toBe(200);
  });
});

describe('apps and API keys', () => {
  it('lets an owner add an app, give it a key that works, and revoke it', async () => {
    const ctx = await start();
    const app = await signedIn(ctx);
    const added = await app('POST', '/app/accounts/current/apps', { name: 'Caleane' });
    expect(added.status).toBe(201);
    const caleane = (await added.json()) as { id: string; name: string; direct: boolean; keys: unknown[] };
    expect(caleane).toMatchObject({ name: 'Caleane', direct: false, keys: [] });

    const made = await app('POST', `/app/accounts/current/apps/${caleane.id}/keys`, { name: 'Caleane production' });
    const { id: keyId, key } = (await made.json()) as { id: string; key: string };
    expect(key).toMatch(/^pk_live_/);
    const listed = (await (await app('GET', '/app/accounts/current/apps')).json()) as { name: string; keys: { name: string; prefix: string }[] }[];
    // The key itself is shown once; afterwards only its start.
    expect(listed.find((a) => a.name === 'Caleane')!.keys).toEqual([expect.objectContaining({ name: 'Caleane production', prefix: key.slice(0, 12) })]);
    expect(JSON.stringify(listed)).not.toContain(key);

    const withKey = (method: string, path: string, body: unknown) =>
      ctx.api.request(path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await withKey('PUT', '/v1/tenants/nay-decor', { name: 'NAY DÉCOR' })).status).toBe(200);

    const origins = await app('PUT', `/app/accounts/current/apps/${caleane.id}/origins`, { origins: ['https://app.caleane.com'] });
    expect(await origins.json()).toEqual({ origins: ['https://app.caleane.com'] });

    expect((await app('DELETE', `/app/accounts/current/keys/${keyId}`)).status).toBe(204);
    expect((await withKey('PUT', '/v1/tenants/nay-decor', { name: 'NAY DÉCOR' })).status).toBe(401);
  });

  it('keeps keys to owners and admins', async () => {
    const ctx = await start();
    const member = await signedIn(ctx, { role: 'member' });
    expect((await member('GET', '/app/accounts/current/apps')).status).toBe(200);
    expect((await member('POST', '/app/accounts/current/apps', { name: 'Sneaky' })).status).toBe(403);
    expect((await member('POST', `/app/accounts/current/apps/${ctx.appId}/keys`, {})).status).toBe(403);
    expect((await member('POST', `/app/tenants/${ctx.tenant.id}/billing/plan`, { plan: 'growth' })).status).toBe(403);
    expect((await member('POST', `/app/tenants/${ctx.tenant.id}/resume`, {})).status).toBe(403);
  });

  it('refuses changes sent from another website', async () => {
    const ctx = await start();
    await signedIn(ctx);
    const cookieless = await ctx.api.request(`/app/tenants/${ctx.tenant.id}/brand`, {
      method: 'PUT',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: JSON.stringify({ address: 'x' }),
    });
    expect(cookieless.status).toBe(403);
  });
});

describe('a business on its own', () => {
  it('signs up, brings in clients and visits, and picks a plan', async () => {
    const ctx = await start();
    const app = await signedIn(ctx);
    const created = await app('POST', '/app/tenants', { name: 'Fern Nails', address: '2 Fern Street, Leeds', bookingUrl: 'https://fern.test/book', timezone: 'Europe/London' });
    expect(created.status).toBe(201);
    const fern = (await created.json()) as { id: string; app: string; brand: Record<string, string> };
    expect(fern).toMatchObject({ app: 'Direct', brand: { address: '2 Fern Street, Leeds', bookingUrl: 'https://fern.test/book' } });
    const base = `/app/tenants/${fern.id}`;

    const imported = await app('POST', `${base}/import/clients`, { consent: 'granted', clients: [{ email: 'ama@example.com', firstName: 'Ama' }, { email: 'nope' }] });
    expect(await imported.json()).toMatchObject({ added: 1, consented: 1, skipped: [{ row: 2 }] });
    const visits = await app('POST', `${base}/import/visits`, { visits: [{ email: 'ama@example.com', date: '2026-07-01', service: 'Gel nails', price: '30' }] });
    expect(await visits.json()).toMatchObject({ saved: 1, skipped: [] });

    const started = (await (await app('GET', `${base}/getting-started`)).json()) as { steps: { id: string; done: boolean }[] };
    expect(started.steps.filter((s) => s.done).map((s) => s.id)).toEqual(['details', 'clients', 'diary']);

    const billing = await (await app('GET', `${base}/billing`)).json();
    expect(billing).toMatchObject({ billed: 'business', plan: 'free', payments: 'sample', usage: { contacts: 1, emails: 0 } });
    expect((await app('POST', `${base}/billing/plan`, { plan: 'gold' })).status).toBe(422);
    expect(await (await app('POST', `${base}/billing/plan`, { plan: 'starter' })).json()).toEqual({ url: null });
    expect(await (await app('GET', `${base}/billing`)).json()).toMatchObject({ plan: 'starter', status: 'active' });

    // A business inside Saleane is paid for by Saleane.
    const linden = await (await app('GET', `/app/tenants/${ctx.tenant.id}/billing`)).json();
    expect(linden).toMatchObject({ billed: 'app' });
    expect((await app('POST', `/app/tenants/${ctx.tenant.id}/billing/plan`, { plan: 'starter' })).status).toBe(409);
  });

  it('turns away Stripe webhooks when Stripe is not set up', async () => {
    const { api } = await start();
    const response = await api.request('/billing/stripe', { method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=x' } });
    expect(response.status).toBe(404);
  });

  it('emails a link to reset a forgotten password', async () => {
    const sent: Mail[] = [];
    const ctx = await start({ mail: async (m) => void sent.push(m) });
    await signedIn(ctx);
    const asked = await ctx.api.request('/auth/request-password-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB },
      body: JSON.stringify({ email: 'edem@test.dev', redirectTo: `${WEB}/reset-password` }),
    });
    expect(asked.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'edem@test.dev', subject: 'Reset your password' });
    const link = sent[0]!.text.match(/https?:\/\/\S+/)![0];
    const token = new URL(link).pathname.split('/').pop()!;

    const reset = await ctx.api.request('/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB },
      body: JSON.stringify({ token, newPassword: 'another-long-password' }),
    });
    expect(reset.status).toBe(200);
    const signIn = await ctx.api.request('/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB },
      body: JSON.stringify({ email: 'edem@test.dev', password: 'another-long-password' }),
    });
    expect(signIn.status).toBe(200);
  });
});

describe('connecting a booking system', () => {
  it('lets owners connect Square and finishes the return where they are signed in', async () => {
    const square = fakeSquare({ bookings: [], customers: [], services: [] });
    const ctx = await start({ fetch: square.fetch, square: true });
    const owner = await signedIn(ctx);
    const member = await signedIn(ctx, { role: 'member', email: 'member@test.dev' });
    const path = `/app/tenants/${ctx.tenant.id}/diary-connection`;

    expect(await (await member('GET', path)).json()).toEqual({ available: { square: true, phorest: true }, connection: null });
    expect((await member('POST', `${path}/square`, { consent: 'granted' })).status).toBe(403);
    expect((await owner('POST', `${path}/square`, {})).status).toBe(422);
    const { url } = (await (await owner('POST', `${path}/square`, { consent: 'granted' })).json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;

    // Square sends the owner back to the API, which hands the code to the web app's settings page.
    const back = await ctx.api.request(`/connect/square/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(302);
    const target = new URL(back.headers.get('location')!);
    expect(target.origin + target.pathname).toBe(`${WEB}/${ctx.tenant.id}/settings/diary`);
    expect(target.searchParams.get('code')).toBe('abc');
    const refused = await ctx.api.request(`/connect/square/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    expect(new URL(refused.headers.get('location')!).searchParams.get('refused')).toBe('1');
    expect((await ctx.api.request('/connect/square/callback?code=abc&state=forged.state')).status).toBe(400);

    // Only the person who started it can finish it.
    expect((await member('POST', `${path}/square/finish`, { code: 'abc', state })).status).toBe(403);
    const done = await owner('POST', `${path}/square/finish`, { code: 'abc', state });
    expect(await done.json()).toMatchObject({ connection: { provider: 'square', locationName: 'Fern & Fable, Leeds', consent: 'granted' } });

    expect((await member('DELETE', path)).status).toBe(403);
    expect((await owner('DELETE', path)).status).toBe(204);
  });

  it('lets owners connect Phorest with the login Phorest issued', async () => {
    const phorest = fakePhorest({ branches: [{ branchId: 'B1', name: 'Fern & Fable, Leeds' }], appointments: [], clients: [], services: [] });
    const ctx = await start({ fetch: phorest.fetch });
    const owner = await signedIn(ctx);
    const member = await signedIn(ctx, { role: 'member', email: 'member@test.dev' });
    const path = `/app/tenants/${ctx.tenant.id}/diary-connection/phorest`;
    expect((await member('POST', path, PHOREST_TEST_LOGIN)).status).toBe(403);
    expect((await owner('POST', path, { ...PHOREST_TEST_LOGIN, password: 'wrong' })).status).toBe(422);
    const done = await owner('POST', path, PHOREST_TEST_LOGIN);
    const body = await done.json();
    expect(body).toMatchObject({ connection: { provider: 'phorest', locationName: 'Fern & Fable, Leeds' } });
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('accepts only signed Square webhooks', async () => {
    const ctx = await start({ square: true });
    const body = JSON.stringify({ merchant_id: 'MERCHANT', type: 'booking.created' });
    const unsigned = await ctx.api.request('/connect/square/webhook', { method: 'POST', body });
    expect(unsigned.status).toBe(401);
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', 'hook-key').update(`https://api.test/connect/square/webhook${body}`).digest('base64');
    const signed = await ctx.api.request('/connect/square/webhook', { method: 'POST', body, headers: { 'x-square-hmacsha256-signature': signature } });
    expect(await signed.json()).toEqual({ synced: 0 });
  });
});
