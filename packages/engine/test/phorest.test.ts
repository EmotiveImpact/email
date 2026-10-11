import { appointments, consents, contacts, diaryConnections, eq, openSlots } from '@platform/db';
import { afterEach, describe, expect, it } from 'vitest';
import { CONSENT_SOURCES, unseal, wallTime } from '../src/index.ts';
import { fakePhorest, PHOREST_TEST_LOGIN, setup } from '../src/testing.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const DAY = 86_400_000;
const on = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const atUtc = (days: number, hourUtc: number) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
};

/** Fern & Fable on Phorest, two branches. Ama agreed to news, Kofi did not, one client has no email. */
function salon() {
  return fakePhorest({
    branches: [
      { branchId: 'B1', name: 'Fern & Fable, Leeds', timeZone: 'Europe/London', currencyCode: 'GBP' },
      { branchId: 'B2', name: 'Fern & Fable, York', timeZone: 'Europe/London', currencyCode: 'GBP' },
    ],
    appointments: [
      // One visit, two services: counts once.
      { appointmentId: 'A1', bookingId: 'K1', clientId: 'P1', appointmentDate: on(-40), startTime: '10:00:00', endTime: '10:45:00', serviceId: 'GEL', serviceName: 'Gel manicure', price: 35, state: 'PAID', activationState: 'ACTIVE', createdAt: atUtc(-50, 9) },
      { appointmentId: 'A2', bookingId: 'K1', clientId: 'P1', appointmentDate: on(-40), startTime: '10:45:00', endTime: '11:00:00', serviceId: 'ART', serviceName: 'Nail art', price: 10, state: 'PAID', activationState: 'ACTIVE', createdAt: atUtc(-50, 9) },
      { appointmentId: 'A3', bookingId: 'K2', clientId: 'P1', appointmentDate: on(-10), startTime: '14:00:00', endTime: '14:45:00', serviceId: 'GEL', price: 35, state: 'BOOKED', activationState: 'ACTIVE' },
      { appointmentId: 'A4', bookingId: 'K3', clientId: 'P2', appointmentDate: on(5), startTime: '09:30:00', serviceId: 'GEL', price: 35, state: 'BOOKED', activationState: 'ACTIVE' },
      { appointmentId: 'A5', bookingId: 'K4', clientId: 'P2', appointmentDate: on(8), startTime: '09:30:00', serviceId: 'ART', price: 10, state: 'BOOKED', activationState: 'CANCELED' },
      { appointmentId: 'A6', bookingId: 'K5', clientId: 'P3', appointmentDate: on(-3), startTime: '12:00:00', serviceId: 'GEL', state: 'PAID' },
      { appointmentId: 'A7', bookingId: 'K6', clientId: 'P4', appointmentDate: on(-3), startTime: '13:00:00', serviceId: 'GEL', state: 'PAID' },
    ],
    clients: [
      { clientId: 'P1', firstName: 'Ama', lastName: 'Owusu', email: 'Ama@Example.com', mobile: '+447700900123', birthDate: '1990-03-14', emailMarketingConsent: true },
      { clientId: 'P2', firstName: 'Kofi', email: 'kofi@example.com', emailMarketingConsent: false },
      { clientId: 'P3', firstName: 'No Email' },
      { clientId: 'P4', firstName: 'Banned', email: 'banned@example.com', banned: true, emailMarketingConsent: true },
    ],
    services: [
      { serviceId: 'GEL', name: 'Gel manicure', price: 35, duration: 45 },
      { serviceId: 'ART', name: 'Nail art', price: 10, duration: 15 },
    ],
    free: [atUtc(1, 9), atUtc(2, 13), atUtc(9, 10)],
  });
}

async function connected() {
  const phorest = salon();
  const ctx = await setup({ fetch: phorest.fetch });
  close = ctx.close;
  await ctx.engine.connectPhorest(ctx.tenant.id, { ...PHOREST_TEST_LOGIN, branchId: 'B1' });
  return { ...ctx, phorest };
}

describe('connecting Phorest', () => {
  it('checks the login, asks which branch, and keeps the login sealed', async () => {
    const phorest = salon();
    const ctx = await setup({ fetch: phorest.fetch });
    close = ctx.close;

    await expect(ctx.engine.connectPhorest(ctx.tenant.id, { ...PHOREST_TEST_LOGIN, password: 'wrong' })).rejects.toMatchObject({ code: 'phorest_login', status: 422 });
    await expect(ctx.engine.connectPhorest(ctx.tenant.id, { ...PHOREST_TEST_LOGIN, username: '' })).rejects.toMatchObject({ code: 'invalid_request' });

    // Two branches and none chosen: the owner picks, and nothing is saved yet.
    expect(await ctx.engine.connectPhorest(ctx.tenant.id, PHOREST_TEST_LOGIN)).toEqual({
      branches: [
        { id: 'B1', name: 'Fern & Fable, Leeds' },
        { id: 'B2', name: 'Fern & Fable, York' },
      ],
    });
    expect(await ctx.db.select().from(diaryConnections)).toHaveLength(0);

    const result = await ctx.engine.connectPhorest(ctx.tenant.id, { ...PHOREST_TEST_LOGIN, branchId: 'B1' });
    expect(result).toMatchObject({ connection: { provider: 'phorest', locationName: 'Fern & Fable, Leeds', status: 'active' } });
    const [row] = await ctx.db.select().from(diaryConnections);
    expect(row!.accessToken).not.toContain('secret');
    expect(JSON.parse(unseal('test-secret', row!.accessToken))).toEqual({ username: 'global/owner@fern.test', password: 'secret' });
    expect(row!.options).toEqual({ region: 'eu', timeZone: 'Europe/London', currency: 'GBP' });
    expect(ctx.queue.jobs).toContainEqual(expect.objectContaining({ name: 'sync-diary', data: { connectionId: row!.id } }));
    expect(phorest.calls[0]!.path).toBe('/api/business/BIZ/branch');
  });

  it('tells a wrong login apart from Phorest being out of reach', async () => {
    const ctx = await setup({ fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    close = ctx.close;
    await expect(ctx.engine.connectPhorest(ctx.tenant.id, PHOREST_TEST_LOGIN)).rejects.toMatchObject({ code: 'phorest_unreachable', status: 502 });
  });

  it('reads one booking system at a time', async () => {
    const ctx = await connected();
    await ctx.db.update(diaryConnections).set({ provider: 'square' });
    await expect(ctx.engine.connectPhorest(ctx.tenant.id, { ...PHOREST_TEST_LOGIN, branchId: 'B1' })).rejects.toMatchObject({ code: 'already_connected', status: 409 });
  });
});

describe('reading a Phorest diary', () => {
  it('brings in visits, clients with their own consent, and free times', async () => {
    const ctx = await connected();
    await ctx.drain();

    const rows = await ctx.db.select().from(appointments).where(eq(appointments.tenantId, ctx.tenant.id));
    const byId = Object.fromEntries(rows.map((r) => [r.externalId, r]));
    expect(Object.keys(byId).sort()).toEqual(['phorest:K1', 'phorest:K2', 'phorest:K3', 'phorest:K4']);
    expect(byId['phorest:K1']).toMatchObject({ service: 'Gel manicure + Nail art', price: 4500, currency: 'GBP', status: 'completed' });
    expect(byId['phorest:K1']!.startsAt).toEqual(wallTime(on(-40), '10:00:00', 'Europe/London'));
    expect(byId['phorest:K1']!.endsAt).toEqual(wallTime(on(-40), '11:00:00', 'Europe/London'));
    expect(byId['phorest:K1']!.bookedAt.toISOString()).toBe(atUtc(-50, 9));
    expect(byId['phorest:K2']).toMatchObject({ service: 'Gel manicure', status: 'completed' });
    expect(byId['phorest:K3']!.status).toBe('booked');
    expect(byId['phorest:K4']!.status).toBe('cancelled');

    const people = await ctx.db.select().from(contacts).where(eq(contacts.tenantId, ctx.tenant.id));
    expect(people.map((p) => p.email).sort()).toEqual(['ama@example.com', 'kofi@example.com']);
    const ama = people.find((p) => p.email === 'ama@example.com')!;
    expect(ama).toMatchObject({ firstName: 'Ama', marketingConsent: 'granted' });
    expect(ama.attributes).toMatchObject({ phone: '+447700900123', birthday: '03-14' });
    expect(people.find((p) => p.email === 'kofi@example.com')!.marketingConsent).toBe('unknown');
    const [record] = await ctx.db.select().from(consents).where(eq(consents.contactId, ama.id));
    expect(record!.source).toBe(CONSENT_SOURCES.phorest);

    expect(await ctx.db.select().from(openSlots).where(eq(openSlots.tenantId, ctx.tenant.id))).toHaveLength(3);
    const searches = ctx.phorest.calls.filter((c) => c.path.endsWith('/appointments/availability'));
    expect(searches).toHaveLength(2);
    expect(JSON.stringify(searches[0]!.body)).toContain('"serviceId":"GEL"');
    expect((await ctx.engine.diaryConnection(ctx.tenant.id)).connection).toMatchObject({ status: 'active', error: null });
  });

  it('follows a change of mind in Phorest without a new booking', async () => {
    const ctx = await connected();
    await ctx.drain();
    ctx.phorest.data.changed = [{ clientId: 'P1', firstName: 'Ama', email: 'ama@example.com', emailMarketingConsent: false }];
    await ctx.engine.runJob('sync-diary', {});
    await ctx.drain();
    const feed = ctx.phorest.calls.find((c) => c.path === '/api/business/BIZ/client')!;
    expect(feed.query.get('updatedAfter')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{2}\+0000$/);
    const [ama] = await ctx.db.select().from(contacts).where(eq(contacts.email, 'ama@example.com'));
    expect(ama!.marketingConsent).toBe('withdrawn');
  });

  it('says plainly when Phorest stops accepting the login', async () => {
    const ctx = await connected();
    ctx.phorest.state.fail = 401;
    await ctx.drain();
    expect((await ctx.engine.diaryConnection(ctx.tenant.id)).connection).toMatchObject({
      status: 'error',
      error: 'Phorest no longer lets us read this diary. Connect it again from your settings.',
    });
  });

  it('turns wall-clock times into exact moments across the clock change', () => {
    expect(wallTime('2026-07-01', '10:00:00', 'Europe/London').toISOString()).toBe('2026-07-01T09:00:00.000Z');
    expect(wallTime('2026-12-01', '10:00:00', 'Europe/London').toISOString()).toBe('2026-12-01T10:00:00.000Z');
  });

  it('forgets the login on disconnect', async () => {
    const ctx = await connected();
    await ctx.drain();
    const before = ctx.phorest.calls.length;
    await ctx.engine.disconnectDiary(ctx.tenant.id);
    expect(ctx.phorest.calls.length).toBe(before);
    expect(await ctx.db.select().from(diaryConnections)).toHaveLength(0);
    expect(await ctx.db.select().from(openSlots)).toHaveLength(0);
  });
});
