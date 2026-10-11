import { eq, messages, newId } from '@platform/db';
import { afterEach, describe, expect, it } from 'vitest';
import { LogTransport, PlatformError, type Engine } from '../src/index.ts';
import { setup } from '../src/testing.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const DAY = 86_400_000;
const daysFromNow = (n: number, hourUtc = 10) => {
  const d = new Date(Date.now() + n * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};

/** Linden Studio with a booking page, and a few helpers for its diary. */
async function studio() {
  const transport = new LogTransport();
  const ctx = await setup({ transport });
  close = ctx.close;
  const { engine, app, appId } = ctx;
  const tenant = await engine.upsertTenant(appId, 'linden', {
    name: 'Linden Studio',
    fromEmail: 'news@linden.test',
    brand: { address: '4 Linden Row, Leeds', bookingUrl: 'https://linden.test/book' },
  });
  let n = 0;
  /** A client with visits on the given days (negative is the past), every one a balayage. */
  async function client(email: string, firstName: string, visits: number[], options: { consent?: boolean; price?: number } = {}) {
    await engine.upsertContact(app, {
      tenant: 'linden',
      email,
      firstName,
      ...(options.consent !== false && { consent: { marketing: 'granted' as const, source: 'test' } }),
    });
    for (const day of visits) {
      const startsAt = daysFromNow(day);
      await engine.upsertAppointment(app, {
        tenant: 'linden',
        id: `apt-${n++}`,
        email,
        startsAt,
        service: 'Balayage',
        price: options.price ?? 9500,
        status: day < 0 ? 'completed' : 'booked',
        bookedAt: new Date(Math.min(Date.now(), startsAt.getTime()) - 7 * DAY),
      });
    }
  }
  async function turnOn(engine: Engine, kind: string, settings?: Record<string, number>) {
    const flow = (await engine.listFlows(tenant.id)).find((f) => f.kind === kind)!;
    return engine.updateFlow(tenant.id, flow.id, { live: true, settings });
  }
  const run = () => engine.runFlows(tenant.id, new Date(), { ignoreHours: true });
  return { ...ctx, tenant, transport, client, turnOn: (kind: string, settings?: Record<string, number>) => turnOn(engine, kind, settings), run };
}

const failsWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PlatformError);
  expect((error as PlatformError).code).toBe(code);
};

describe('the diary', () => {
  it('works out each client’s rhythm from their visits', async () => {
    const { engine, tenant, client, db } = await studio();
    await client('ama@example.com', 'Ama', [-89, -61, -33]);
    await client('kofi@example.com', 'Kofi', [-60, -30, 5]);
    const rhythms = await engine.rhythms(tenant.id);
    const [ama] = (await db.execute<{ id: string }>(`select id from contacts where email = 'ama@example.com'`)).rows;
    const amaRhythm = rhythms.find((r) => r.contactId === ama!.id)!;
    expect(amaRhythm).toMatchObject({ visits: 3, gapDays: 28, bookedAhead: false, lastService: 'Balayage' });
    expect(Math.round((amaRhythm.dueAt!.getTime() - Date.now()) / DAY)).toBe(-5);
    expect(rhythms.find((r) => r.contactId !== ama!.id)).toMatchObject({ visits: 2, gapDays: 30, bookedAhead: true });
  });

  it('records bookings as events and replaces free time for a window', async () => {
    const { engine, app, tenant, db } = await studio();
    await engine.upsertAppointment(app, { tenant: 'linden', id: 'b1', email: 'ama@example.com', firstName: 'Ama', startsAt: daysFromNow(3), service: 'Cut' });
    await engine.upsertAppointment(app, { tenant: 'linden', id: 'b1', email: 'ama@example.com', startsAt: daysFromNow(3), service: 'Cut', status: 'cancelled' });
    const events = await db.execute<{ name: string }>(`select name from app_events order by occurred_at`);
    expect(events.rows.map((e) => e.name)).toEqual(['booking.created', 'booking.cancelled']);

    const window = { tenant: 'linden', from: daysFromNow(0, 0), to: daysFromNow(7, 0) };
    await engine.setAvailability(app, { ...window, slots: [10, 11, 12].map((h) => ({ startsAt: daysFromNow(2, h), endsAt: daysFromNow(2, h + 1) })) });
    await engine.setAvailability(app, { ...window, slots: [{ startsAt: daysFromNow(3, 9), endsAt: daysFromNow(3, 10) }] });
    const diary = await engine.diaryDays(tenant.id, 7);
    expect(diary.connected).toBe(true);
    expect(diary.days.reduce((sum, d) => sum + d.open, 0)).toBe(1);
  });
});

describe('flows', () => {
  it('will not go live without a booking link', async () => {
    const { engine, appId, tenant } = await studio();
    await engine.upsertTenant(appId, 'linden', { name: 'Linden Studio', brand: { address: '4 Linden Row, Leeds' } });
    const flow = (await engine.listFlows(tenant.id)).find((f) => f.kind === 'rebook')!;
    expect(flow.problems[0]).toMatch(/booking link/);
    await failsWith(engine.updateFlow(tenant.id, flow.id, { live: true }), 'not_ready');
    await failsWith(engine.updateFlow(tenant.id, flow.id, { settings: { graceDays: 400 } }), 'invalid_request');
  });

  it('nudges clients who are past their usual gap, once, with free times to book', async () => {
    const { engine, app, tenant, client, turnOn, run, drain, transport } = await studio();
    await client('ama@example.com', 'Ama', [-89, -61, -33]);
    await client('kofi@example.com', 'Kofi', [-89, -61, -33, 4]); // already booked
    await client('maya@example.com', 'Maya', [-89, -61, -33], { consent: false });
    await client('esi@example.com', 'Esi', [-40, -10]); // not due yet
    await engine.setAvailability(app, {
      tenant: 'linden',
      from: daysFromNow(0, 0),
      to: daysFromNow(14, 0),
      slots: [{ startsAt: daysFromNow(2, 9), endsAt: daysFromNow(2, 10) }],
    });
    const rebook = await turnOn('rebook');
    expect((await engine.flowDetail(tenant.id, rebook.id)).waiting).toBe(1);

    expect(await run()).toEqual({ rebook: 1 });
    expect(await run()).toEqual({});
    await drain();
    expect(transport.sent).toHaveLength(1);
    const [email] = transport.sent;
    expect(email).toMatchObject({ to: 'ama@example.com', subject: 'Time for your next Balayage?' });
    expect(email!.html).toContain('5 weeks since your Balayage');
    expect(email!.html).toContain('https://linden.test/book?at=');
    expect(email!.html).not.toContain('{{');
  });

  it('offers a quiet day’s free times to the clients closest to due, a few per slot', async () => {
    const { engine, app, tenant, client, turnOn, run, drain, transport } = await studio();
    for (const [i, name] of ['Ama', 'Kofi', 'Maya', 'Esi', 'Yaw'].entries()) await client(`${name.toLowerCase()}@example.com`, name, [-60 - i, -30 - i]);
    const day = daysFromNow(2, 9);
    await engine.setAvailability(app, {
      tenant: 'linden',
      from: daysFromNow(0, 0),
      to: daysFromNow(14, 0),
      slots: [0, 1, 2].map((h) => ({ startsAt: new Date(day.getTime() + h * 3600_000), endsAt: new Date(day.getTime() + (h + 1) * 3600_000) })),
    });
    const fill = await turnOn('fill_slots', { perSlot: 1 });
    const { next } = await engine.flowDetail(tenant.id, fill.id);
    expect(next.total).toBe(3);
    expect(next.fill).toMatchObject({ open: 3, times: ['10am', '11am', '12pm'] });
    expect(next.people.map((p) => p.firstName)).toEqual(['Ama', 'Kofi', 'Maya']);

    expect(await run()).toEqual({ fill_slots: 3 });
    expect(await run()).toEqual({}); // that day has had its offer
    await drain();
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'Europe/London' }).format(day);
    expect(transport.sent.map((m) => m.to).sort()).toEqual(['ama@example.com', 'kofi@example.com', 'maya@example.com']);
    expect(transport.sent[0]!.subject).toMatch(new RegExp(`^Space on ${weekday}, `));
    expect(transport.sent[0]!.html).toContain('>10am<');
  });

  it('thanks first-time clients a couple of days after their visit', async () => {
    const { client, turnOn, run, drain, transport } = await studio();
    await client('ama@example.com', 'Ama', [-3]);
    await client('kofi@example.com', 'Kofi', [-1]); // too soon
    await client('maya@example.com', 'Maya', [-60, -3]); // not a first visit
    await turnOn('welcome');
    expect(await run()).toEqual({ welcome: 1 });
    await drain();
    expect(transport.sent[0]).toMatchObject({ to: 'ama@example.com', subject: 'Thank you for coming in, Ama' });
  });

  it('leaves three days between marketing emails and only sends in the daytime', async () => {
    const { engine, db, tenant, client, turnOn } = await studio();
    await client('ama@example.com', 'Ama', [-89, -61, -33]);
    await client('kofi@example.com', 'Kofi', [-89, -61, -33]);
    await db.insert(messages).values({ id: newId('msg'), tenantId: tenant.id, stream: 'marketing', to: 'kofi@example.com', from: 'x', subject: 'Campaign', status: 'delivered' });
    await turnOn('rebook');
    const night = new Date(Date.now() - DAY);
    night.setUTCHours(2, 0, 0, 0);
    expect(await engine.runFlows(tenant.id, night)).toEqual({});
    const day = new Date(night.getTime() + 10 * 3600_000);
    expect(await engine.runFlows(tenant.id, day)).toEqual({ rebook: 1 });
  });

  it('credits a booking to the email the client had just before it', async () => {
    const { engine, app, tenant, client, turnOn, run, drain, db } = await studio();
    await client('ama@example.com', 'Ama', [-89, -61, -33]);
    const rebook = await turnOn('rebook');
    await run();
    await drain();
    await engine.upsertAppointment(app, { tenant: 'linden', id: 'new', email: 'ama@example.com', startsAt: daysFromNow(4), service: 'Balayage', price: 12000 });
    const detail = await engine.flowDetail(tenant.id, rebook.id);
    expect(detail.stats).toMatchObject({ sent: 1, bookings: 1, revenue: 12000 });
    expect(detail.recent).toHaveLength(1);
    const [sent] = await db.select().from(messages).where(eq(messages.flowId, rebook.id));
    expect(sent!.tags).toMatchObject({ kind: 'rebook' });
  });

  it('runs every business with a live flow from the hourly tick', async () => {
    const { engine, queue, tenant, turnOn } = await studio();
    await turnOn('winback');
    queue.jobs.length = 0;
    await engine.runJob('run-flows', {});
    expect(queue.jobs).toEqual([{ name: 'run-flows', data: { tenantId: tenant.id }, startAfter: undefined }]);
  });
});
