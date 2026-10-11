/** Test helpers: a fresh, migrated Postgres database and an engine with in-memory queue and transport. */
import { createDb, sql } from '@platform/db';
import { migrateDb } from '@platform/db/migrate';
import { createEngine, LocalProvisioner, LogTransport, MemoryQueue, type EngineConfig, type ImageGenerator, type PaymentProvider, type Provisioner, type PhorestAppointment, type PhorestBranch, type PhorestClient, type PhorestService, type SquareBooking, type SquareConfig, type SquareCustomer, type Transport } from './index.ts';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://platform:platform@localhost:5432/platform_test';

/** A fresh, migrated database and an engine wired to an in-memory queue and transport. */
export async function setup(
  options: {
    transport?: Transport;
    fetch?: typeof fetch;
    config?: Partial<EngineConfig>;
    provisioner?: Provisioner;
    resolveTxt?: (name: string) => Promise<string[][]>;
    imageGenerator?: ImageGenerator;
    /** Undefined: the sample provider. Null: payments off. */
    paymentProvider?: PaymentProvider | null;
    square?: SquareConfig | null;
  } = {},
) {
  const { db, pool } = createDb(TEST_DATABASE_URL);
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await migrateDb(db);
  const transport = options.transport ?? new LogTransport();
  const queue = new MemoryQueue();
  const engine = createEngine({
    db,
    transport,
    queue,
    fetch: options.fetch,
    provisioner: options.provisioner ?? new LocalProvisioner(),
    resolveTxt: options.resolveTxt ?? (async () => []),
    // Test hosts such as saleane.test do not resolve; treat them as public (TEST-NET-3).
    resolveHost: async () => ['203.0.113.10'],
    imageGenerator: options.imageGenerator,
    paymentProvider: options.paymentProvider,
    square: options.square,
    config: { publicUrl: 'https://api.test', signingSecret: 'test-secret', defaultFrom: 'hello@platform.test', ...options.config },
  });
  const { accountId, appId } = await engine.createAccountWithApp({ account: 'Emotive Impact', app: 'Saleane' });
  const { key } = await engine.createApiKey(appId, 'test');
  const app = await engine.authenticate(key);
  const tenant = await engine.upsertTenant(appId, 'linden', { name: 'Linden Studio', fromEmail: 'news@linden.test', brand: { address: '4 Linden Row, Leeds' } });
  const drain = () => queue.drain((name, data) => engine.runJob(name, data));
  return { db, pool, engine, transport, queue, app, accountId, appId, tenant, key, drain, close: () => pool.end() };
}

/**
 * A stand-in for Square's API with one business: a location, bookings, customers, services and
 * free times. Pass `fetch` to the engine; `calls` records what was asked, `fail` makes it refuse.
 */
export function fakeSquare(data: {
  bookings: SquareBooking[];
  customers: SquareCustomer[];
  services: { id: string; item: string; name?: string; price?: number; minutes?: number }[];
  free?: string[];
}) {
  const calls: { method: string; path: string; body: unknown; authorization: string | null }[] = [];
  const state = { fail: null as null | number, token: 'tok-1', refreshed: 0, revoked: [] as string[] };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    if (!url.host.startsWith('connect.squareup')) return json({ ok: true });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const authorization = new Headers(init.headers).get('authorization');
    calls.push({ method: init.method ?? 'GET', path: url.pathname, body, authorization });
    if (url.pathname === '/oauth2/token') {
      if (body.grant_type === 'refresh_token') state.refreshed++;
      state.token = body.grant_type === 'refresh_token' ? `tok-${state.refreshed + 1}` : 'tok-1';
      return json({ access_token: state.token, refresh_token: 'refresh-1', expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), merchant_id: 'MERCHANT' });
    }
    if (url.pathname === '/oauth2/revoke') {
      state.revoked.push(body.access_token);
      return json({ success: true });
    }
    if (state.fail) return json({ errors: [{ code: 'UNAUTHORIZED', detail: 'The access token has expired.' }] }, state.fail);
    if (authorization !== `Bearer ${state.token}`) return json({ errors: [{ code: 'UNAUTHORIZED', detail: 'Wrong token.' }] }, 401);
    if (url.pathname === '/v2/locations') return json({ locations: [{ id: 'LOC', name: 'Fern & Fable, Leeds', status: 'ACTIVE' }] });
    if (url.pathname === '/v2/bookings') {
      const min = new Date(url.searchParams.get('start_at_min')!);
      const max = new Date(url.searchParams.get('start_at_max')!);
      return json({ bookings: data.bookings.filter((b) => new Date(b.start_at) >= min && new Date(b.start_at) < max) });
    }
    if (url.pathname === '/v2/customers/bulk-retrieve') {
      const responses = Object.fromEntries((body.customer_ids as string[]).map((id) => [id, { customer: data.customers.find((c) => c.id === id) }]));
      return json({ responses });
    }
    if (url.pathname === '/v2/catalog/batch-retrieve') {
      const wanted = data.services.filter((s) => (body.object_ids as string[]).includes(s.id));
      return json({
        objects: wanted.map((s) => ({
          id: s.id,
          type: 'ITEM_VARIATION',
          item_variation_data: {
            item_id: `item-${s.id}`,
            name: s.name ?? 'Regular',
            ...(s.price !== undefined && { price_money: { amount: s.price, currency: 'GBP' } }),
            ...(s.minutes && { service_duration: s.minutes * 60_000 }),
          },
        })),
        related_objects: wanted.map((s) => ({ id: `item-${s.id}`, type: 'ITEM', item_data: { name: s.item } })),
      });
    }
    if (url.pathname === '/v2/bookings/availability/search') {
      return json({ availabilities: (data.free ?? []).map((start_at) => ({ start_at, location_id: 'LOC', appointment_segments: [{ duration_minutes: 45, team_member_id: 'TM1' }] })) });
    }
    return json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls, state, data };
}

export const SQUARE_TEST_CONFIG: SquareConfig = { appId: 'sq0idp-test', appSecret: 'sq0csp-secret', webhookSignatureKey: 'hook-key', environment: 'production' };

/**
 * A stand-in for Phorest's API with one business and its branches. The login is "global/owner@fern.test"
 * with "secret". `calls` records what was asked; `data` can be changed between reads.
 */
export function fakePhorest(data: {
  branches: PhorestBranch[];
  appointments: PhorestAppointment[];
  clients: PhorestClient[];
  services: PhorestService[];
  free?: string[];
  /** Clients returned as changed since the last read. */
  changed?: PhorestClient[];
}) {
  const calls: { method: string; path: string; query: URLSearchParams; body: unknown }[] = [];
  const state = { fail: null as null | number };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const paged = (key: string, rows: unknown[], query: URLSearchParams) => {
    const size = Number(query.get('size') ?? 20);
    const page = Number(query.get('page') ?? 0);
    return json({ _embedded: { [key]: rows.slice(page * size, (page + 1) * size) }, page: { size, number: page, totalElements: rows.length, totalPages: Math.ceil(rows.length / size) } });
  };
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    if (!url.host.includes('phorest.com')) return json({ ok: true });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace('/third-party-api-server', '');
    calls.push({ method: init.method ?? 'GET', path, query: url.searchParams, body });
    const expected = `Basic ${Buffer.from('global/owner@fern.test:secret').toString('base64')}`;
    if (state.fail || new Headers(init.headers).get('authorization') !== expected) return json({ detail: 'Unauthorized' }, state.fail ?? 401);
    if (!path.startsWith('/api/business/BIZ/')) return json({ detail: 'Business not found' }, 404);
    const rest = path.slice('/api/business/BIZ'.length);
    if (rest === '/branch') return paged('branches', data.branches, url.searchParams);
    if (/^\/branch\/[^/]+\/appointment$/.test(rest)) {
      const from = url.searchParams.get('from_date')!;
      const to = url.searchParams.get('to_date')!;
      return paged('appointments', data.appointments.filter((a) => a.appointmentDate >= from && a.appointmentDate <= to), url.searchParams);
    }
    if (/^\/branch\/[^/]+\/service$/.test(rest)) return paged('services', data.services, url.searchParams);
    if (rest === '/client-batch') {
      const ids = url.searchParams.getAll('client_id');
      return paged('clients', data.clients.filter((c) => ids.includes(c.clientId)), url.searchParams);
    }
    if (rest === '/client') return paged('clients', data.changed ?? [], url.searchParams);
    if (/^\/branch\/[^/]+\/appointments\/availability$/.test(rest)) {
      const start = new Date(body.startTime).getTime();
      const end = new Date(body.endTime).getTime();
      const inside = (data.free ?? []).filter((t) => new Date(t).getTime() >= start && new Date(t).getTime() < end);
      return json({ data: inside.map((startTime) => ({ startTime, clientSchedules: [{ serviceSchedules: [{ serviceId: body.clientServiceSelections[0].serviceSelections[0].serviceId, staffId: 'S1', startTime }] }] })) });
    }
    return json({ detail: 'Not found' }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls, state, data };
}

export const PHOREST_TEST_LOGIN = { username: 'global/owner@fern.test', password: 'secret', businessId: 'BIZ', region: 'eu' as const };
