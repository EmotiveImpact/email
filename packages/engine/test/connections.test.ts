import { createHmac } from 'node:crypto';
import { appointments, contacts, diaryConnections, eq, openSlots } from '@platform/db';
import { afterEach, describe, expect, it } from 'vitest';
import { FIRST_SYNC_DAYS, PlatformError, statusOf, unseal } from '../src/index.ts';
import { fakeSquare, setup, SQUARE_TEST_CONFIG } from '../src/testing.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const DAY = 86_400_000;
const at = (days: number, hourUtc = 10) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
};

/** Fern & Fable on Square: three clients, one without an email, one who unsubscribed in Square. */
function salon() {
  return fakeSquare({
    bookings: [
      { id: 'B1', status: 'ACCEPTED', start_at: at(-40), created_at: at(-50), customer_id: 'C1', appointment_segments: [{ duration_minutes: 45, service_variation_id: 'V1' }] },
      { id: 'B2', status: 'ACCEPTED', start_at: at(-12), created_at: at(-20), customer_id: 'C1', appointment_segments: [{ duration_minutes: 45, service_variation_id: 'V1' }] },
      { id: 'B3', status: 'NO_SHOW', start_at: at(-5), customer_id: 'C2', appointment_segments: [{ duration_minutes: 60, service_variation_id: 'V2' }] },
      { id: 'B4', status: 'CANCELLED_BY_CUSTOMER', start_at: at(3), customer_id: 'C2', appointment_segments: [{ duration_minutes: 60, service_variation_id: 'V2' }] },
      { id: 'B5', status: 'ACCEPTED', start_at: at(6), customer_id: 'C1', appointment_segments: [{ duration_minutes: 45, service_variation_id: 'V1' }, { duration_minutes: 15, service_variation_id: 'V3' }] },
      { id: 'B6', status: 'ACCEPTED', start_at: at(-2), customer_id: 'C3', appointment_segments: [{ duration_minutes: 30, service_variation_id: 'V1' }] },
      // Older than the first read reaches back: never asked for.
      { id: 'B7', status: 'ACCEPTED', start_at: at(-(FIRST_SYNC_DAYS + 20)), customer_id: 'C1', appointment_segments: [{ service_variation_id: 'V1' }] },
    ],
    customers: [
      { id: 'C1', email_address: 'Ama@Example.com', given_name: 'Ama', family_name: 'Owusu', phone_number: '+447700900123', birthday: '0000-03-14' },
      { id: 'C2', email_address: 'kofi@example.com', given_name: 'Kofi', preferences: { email_unsubscribed: true } },
      { id: 'C3', given_name: 'No Email' },
    ],
    services: [
      { id: 'V1', item: 'Gel manicure', price: 3500, minutes: 45 },
      { id: 'V2', item: 'Cut and blow-dry', name: 'Long hair', price: 6000, minutes: 60 },
      { id: 'V3', item: 'Nail art', price: 1000, minutes: 15 },
    ],
    free: [at(1, 9), at(1, 14), at(2, 11)],
  });
}

async function connected(consent: 'granted' | 'unknown' = 'granted') {
  const square = salon();
  const ctx = await setup({ fetch: square.fetch, square: SQUARE_TEST_CONFIG });
  close = ctx.close;
  const { url } = ctx.engine.squareConnectUrl(ctx.tenant.id, 'user-1', consent);
  const state = new URL(url).searchParams.get('state')!;
  await ctx.engine.finishSquareConnect(ctx.tenant.id, 'user-1', 'code-1', state);
  return { ...ctx, square, url, state };
}

describe('connecting Square', () => {
  it('asks Square for read-only access and binds the return to the business and person', async () => {
    const square = salon();
    const ctx = await setup({ fetch: square.fetch, square: SQUARE_TEST_CONFIG });
    close = ctx.close;
    const { url } = ctx.engine.squareConnectUrl(ctx.tenant.id, 'user-1', 'granted');
    const link = new URL(url);
    expect(link.origin + link.pathname).toBe('https://connect.squareup.com/oauth2/authorize');
    expect(link.searchParams.get('client_id')).toBe('sq0idp-test');
    expect(link.searchParams.get('scope')!.split(' ').every((s) => s.endsWith('_READ'))).toBe(true);
    const state = link.searchParams.get('state')!;
    expect(ctx.engine.connectReturnTenant(state)).toBe(ctx.tenant.id);
    expect(ctx.engine.connectReturnTenant(`${state.split('.')[0]}.forged`)).toBeNull();

    // Someone else, or another business, cannot finish it.
    await expect(ctx.engine.finishSquareConnect(ctx.tenant.id, 'user-2', 'code-1', state)).rejects.toMatchObject({ code: 'invalid_state' });
    const other = await ctx.engine.upsertTenant(ctx.appId, 'other', { name: 'Other' });
    await expect(ctx.engine.finishSquareConnect(other.id, 'user-1', 'code-1', state)).rejects.toMatchObject({ code: 'invalid_state' });

    const result = await ctx.engine.finishSquareConnect(ctx.tenant.id, 'user-1', 'code-1', state);
    expect(result.connection).toMatchObject({ provider: 'square', locationName: 'Fern & Fable, Leeds', consent: 'granted', status: 'active', lastSyncAt: null });
    expect(result.connection).not.toHaveProperty('accessToken');

    // Tokens are sealed at rest.
    const [row] = await ctx.db.select().from(diaryConnections);
    expect(row!.accessToken).not.toContain('tok-1');
    expect(unseal('test-secret', row!.accessToken)).toBe('tok-1');
    expect(unseal('test-secret', row!.refreshToken!)).toBe('refresh-1');
    expect(ctx.queue.jobs).toContainEqual(expect.objectContaining({ name: 'sync-diary', data: { connectionId: row!.id } }));
  });

  it('says plainly when Square is not switched on', async () => {
    const ctx = await setup();
    close = ctx.close;
    expect(() => ctx.engine.squareConnectUrl(ctx.tenant.id, 'user-1', 'unknown')).toThrow(PlatformError);
    expect(await ctx.engine.diaryConnection(ctx.tenant.id)).toEqual({ available: { square: false, phorest: true }, connection: null });
  });
});

describe('reading the diary', () => {
  it('brings in bookings, clients and free times', async () => {
    const ctx = await connected();
    await ctx.drain();

    const rows = await ctx.db.select().from(appointments).where(eq(appointments.tenantId, ctx.tenant.id));
    const byId = Object.fromEntries(rows.map((r) => [r.externalId, r]));
    expect(Object.keys(byId).sort()).toEqual(['square:B1', 'square:B2', 'square:B3', 'square:B4', 'square:B5']);
    expect(byId['square:B1']).toMatchObject({ status: 'completed', service: 'Gel manicure', price: 3500, currency: 'GBP' });
    expect(byId['square:B3']).toMatchObject({ status: 'no_show', service: 'Cut and blow-dry (Long hair)', price: 6000 });
    expect(byId['square:B4']!.status).toBe('cancelled');
    expect(byId['square:B5']).toMatchObject({ status: 'booked', service: 'Gel manicure + Nail art', price: 4500 });
    expect(byId['square:B5']!.endsAt!.getTime() - byId['square:B5']!.startsAt.getTime()).toBe(60 * 60_000);
    expect(byId['square:B1']!.bookedAt.toISOString()).toBe(at(-50));

    // Owner confirmed consent: Ama agrees to news; Kofi unsubscribed in Square, so he does not.
    const people = await ctx.db.select().from(contacts).where(eq(contacts.tenantId, ctx.tenant.id));
    const ama = people.find((p) => p.email === 'ama@example.com')!;
    const kofi = people.find((p) => p.email === 'kofi@example.com')!;
    expect(ama).toMatchObject({ firstName: 'Ama', lastName: 'Owusu', marketingConsent: 'granted' });
    expect(ama.attributes).toMatchObject({ phone: '+447700900123', birthday: '03-14' });
    expect(kofi.marketingConsent).toBe('unknown');

    // Free times for the most booked service, so emails can offer them.
    const slots = await ctx.db.select().from(openSlots).where(eq(openSlots.tenantId, ctx.tenant.id));
    expect(slots).toHaveLength(3);
    const search = ctx.square.calls.find((c) => c.path === '/v2/bookings/availability/search')!;
    expect(JSON.stringify(search.body)).toContain('"service_variation_id":"V1"');
    expect((await ctx.engine.diaryDays(ctx.tenant.id)).connected).toBe(true);

    const { connection } = await ctx.engine.diaryConnection(ctx.tenant.id);
    expect(connection).toMatchObject({ status: 'active', error: null });
    expect(connection!.lastSyncAt).not.toBeNull();

    // Later reads look back a week, not six months.
    const before = ctx.square.calls.filter((c) => c.path === '/v2/bookings').length;
    await ctx.engine.runJob('sync-diary', {});
    await ctx.drain();
    expect(ctx.square.calls.filter((c) => c.path === '/v2/bookings').length - before).toBe(2);
  });

  it('leaves consent alone when the owner was not sure, and mirrors Square unsubscribes', async () => {
    const unsure = await connected('unknown');
    await unsure.drain();
    const people = await unsure.db.select().from(contacts).where(eq(contacts.tenantId, unsure.tenant.id));
    expect(people.every((p) => p.marketingConsent === 'unknown')).toBe(true);
    await close?.();
    close = undefined;

    const ctx = await connected('granted');
    await ctx.drain();
    // Ama unsubscribes in Square: the yes that came from Square goes.
    const ama = ctx.square.data.customers.find((c) => c.id === 'C1')!;
    ama.preferences = { email_unsubscribed: true };
    await ctx.engine.runJob('sync-diary', {});
    await ctx.drain();
    const [after] = await ctx.db.select().from(contacts).where(eq(contacts.email, 'ama@example.com'));
    expect(after!.marketingConsent).toBe('withdrawn');
  });

  it('keeps a yes the client gave another way', async () => {
    const ctx = await connected('granted');
    // Kofi joined through the salon's own form, after unsubscribing in Square long ago.
    await ctx.engine.upsertContact(ctx.app, { tenant: 'linden', email: 'kofi@example.com', consent: { marketing: 'granted', source: 'saleane:booking-form' } });
    await ctx.drain();
    const [kofi] = await ctx.db.select().from(contacts).where(eq(contacts.email, 'kofi@example.com'));
    expect(kofi!.marketingConsent).toBe('granted');
  });

  it('refreshes the token before it lapses', async () => {
    const ctx = await connected();
    await ctx.db.update(diaryConnections).set({ expiresAt: new Date(Date.now() + 2 * DAY) });
    await ctx.drain();
    expect(ctx.square.state.refreshed).toBe(1);
    const [row] = await ctx.db.select().from(diaryConnections);
    expect(unseal('test-secret', row!.accessToken)).toBe('tok-2');
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 20 * DAY);
    expect(row!.status).toBe('active');
  });

  it('marks the connection when Square stops letting us read', async () => {
    const ctx = await connected();
    ctx.square.state.fail = 401;
    await ctx.drain();
    const { connection } = await ctx.engine.diaryConnection(ctx.tenant.id);
    expect(connection).toMatchObject({ status: 'error', error: 'Square no longer lets us read this diary. Connect it again from your settings.' });
  });

  it('reads Square booking statuses', () => {
    const now = new Date();
    const past = new Date(now.getTime() - DAY).toISOString();
    const future = new Date(now.getTime() + DAY).toISOString();
    expect(statusOf({ id: 'x', status: 'ACCEPTED', start_at: past }, now)).toBe('completed');
    expect(statusOf({ id: 'x', status: 'ACCEPTED', start_at: future }, now)).toBe('booked');
    expect(statusOf({ id: 'x', status: 'PENDING', start_at: past }, now)).toBe('booked');
    expect(statusOf({ id: 'x', status: 'NO_SHOW', start_at: past }, now)).toBe('no_show');
    expect(statusOf({ id: 'x', status: 'DECLINED', start_at: future }, now)).toBe('cancelled');
  });
});

describe('Square webhooks', () => {
  const sign = (body: string) => createHmac('sha256', 'hook-key').update(`https://api.test/connect/square/webhook${body}`).digest('base64');

  it('syncs the business straight away when a booking changes', async () => {
    const ctx = await connected();
    await ctx.drain();
    const body = JSON.stringify({ merchant_id: 'MERCHANT', type: 'booking.updated', data: { id: 'B5' } });
    await expect(ctx.engine.squareWebhook(body, 'bad')).rejects.toMatchObject({ code: 'invalid_signature' });
    expect(await ctx.engine.squareWebhook(body, sign(body))).toEqual({ synced: 1 });
    expect(ctx.queue.jobs.map((j) => j.name)).toEqual(['sync-diary']);

    const other = JSON.stringify({ merchant_id: 'MERCHANT', type: 'customer.updated' });
    expect(await ctx.engine.squareWebhook(other, sign(other))).toEqual({ synced: 0 });
  });
});

describe('disconnecting', () => {
  it('withdraws access, keeps past bookings and clears free times', async () => {
    const ctx = await connected();
    await ctx.drain();
    await ctx.engine.disconnectDiary(ctx.tenant.id);
    expect(ctx.square.state.revoked).toEqual(['tok-1']);
    expect(await ctx.db.select().from(diaryConnections)).toHaveLength(0);
    expect(await ctx.db.select().from(openSlots)).toHaveLength(0);
    expect((await ctx.db.select().from(appointments)).length).toBeGreaterThan(0);
    expect((await ctx.engine.diaryConnection(ctx.tenant.id)).connection).toBeNull();
  });
});
