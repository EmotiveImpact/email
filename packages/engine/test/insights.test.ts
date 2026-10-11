import { messages, newId } from '@platform/db';
import { afterEach, describe, expect, it } from 'vitest';
import { LogTransport } from '../src/index.ts';
import { setup } from '../src/testing.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const DAY = 86_400_000;
/** A time `n` days from now at the given London hour (the tests run on UTC dates, BST or GMT aside). */
const at = (n: number, hourUtc = 10) => {
  const d = new Date(Date.now() + n * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};

async function studio() {
  const ctx = await setup({ transport: new LogTransport() });
  close = ctx.close;
  const { engine, app, appId, db } = ctx;
  const tenant = await engine.upsertTenant(appId, 'linden', {
    name: 'Linden Studio',
    fromEmail: 'news@linden.test',
    brand: { address: '4 Linden Row, Leeds', bookingUrl: 'https://linden.test/book' },
    timezone: 'UTC',
  });
  let n = 0;
  const book = (email: string, startsAt: Date, bookedAt: Date, price = 6000, status: 'booked' | 'completed' = 'booked') =>
    engine.upsertAppointment(app, { tenant: 'linden', id: `apt-${n++}`, email, startsAt, bookedAt, service: 'Cut', price, status });
  const email = (to: string, sentAt: Date, source: { flowId?: string; campaignId?: string }) =>
    db.insert(messages).values({ id: newId('msg'), tenantId: tenant.id, stream: 'marketing', to, from: 'x', subject: 'Hello', status: 'delivered', sentAt, ...source });
  return { ...ctx, tenant, book, email };
}

describe('the overview', () => {
  it('adds up money booked from email against the period before', async () => {
    const { engine, tenant, book, email } = await studio();
    const [rebook] = (await engine.listFlows(tenant.id)).filter((f) => f.kind === 'rebook');
    await email('ama@example.com', at(-3), { flowId: rebook!.id });
    await book('ama@example.com', at(4), at(-2), 9000);
    await email('kofi@example.com', at(-40), { campaignId: 'cmp_x' });
    await book('kofi@example.com', at(-20), at(-38), 6000, 'completed');
    // Booked with no email before it: not counted.
    await book('esi@example.com', at(5), at(-1), 12000);

    const { revenue, flows } = await engine.overview(tenant.id, 30);
    expect(revenue).toMatchObject({ revenue: 9000, bookings: 1, previous: 6000, previousBookings: 1, flows: 9000, campaigns: 0, change: 50 });
    expect(revenue.daily).toHaveLength(30);
    expect(revenue.daily.slice(-3).reduce((sum, d) => sum + d.revenue, 0)).toBe(9000);
    expect(flows.find((f) => f.kind === 'rebook')).toMatchObject({ sent: 1, bookings: 1, revenue: 9000 });
  });

  it('lays the week out by part of the day and finds the quietest stretch', async () => {
    const { engine, app, tenant } = await studio();
    await engine.setAvailability(app, {
      tenant: 'linden',
      from: at(0, 0),
      to: at(7, 0),
      slots: [
        { startsAt: at(2, 9), endsAt: at(2, 10) },
        { startsAt: at(2, 14), endsAt: at(2, 15) },
        { startsAt: at(2, 15), endsAt: at(2, 16) },
        { startsAt: at(2, 16), endsAt: at(2, 17) },
      ],
    });
    const { week } = await engine.overview(tenant.id);
    expect(week.parts).toEqual(['Morning', 'Midday', 'Afternoon', 'Evening']);
    const day = week.days.find((d) => d.open === 4)!;
    expect(day.parts.map((p) => p.open)).toEqual([1, 0, 3, 0]);
    expect(week.quietest).toMatchObject({ day: day.day, part: 2, open: 3, dayOpen: 4 });
  });

  it('suggests filling the quiet stretch first, then the flows that are off', async () => {
    const { engine, app, tenant, book } = await studio();
    for (const [i, name] of ['ama', 'kofi', 'maya'].entries()) {
      await book(`${name}@example.com`, at(-60 - i), at(-70), 5000, 'completed');
      await book(`${name}@example.com`, at(-30 - i), at(-40), 5000, 'completed');
    }
    await engine.setAvailability(app, {
      tenant: 'linden',
      from: at(0, 0),
      to: at(7, 0),
      slots: [14, 15, 16].map((h) => ({ startsAt: at(3, h), endsAt: at(3, h + 1) })),
    });
    const { opportunities } = await engine.overview(tenant.id);
    expect(opportunities.map((o) => o.kind)).toEqual(['fill', 'rebook']);
    const weekday = at(3).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
    expect(opportunities[0]).toMatchObject({ title: `Fill ${weekday} afternoon`, value: 15000, people: { initials: ['M', 'K', 'A'], more: 0 } });
    expect(opportunities[0]!.detail).toMatch(/^Three free slots\. Three clients are due back/);
    expect(opportunities[1]).toMatchObject({ title: 'Three clients come due in the next two weeks', action: { label: 'Review and switch on' } });
    // None is past their gap with a yes to news, so the flow page shows nobody waiting either.
    expect((await engine.listFlows(tenant.id)).find((f) => f.kind === 'rebook')!.waiting).toBe(0);
  });
});
