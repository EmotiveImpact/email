/**
 * Home's numbers: money booked from email, the week ahead by time of day, and the few things most
 * worth doing today. Everything is worked out from the diary and the sending records when asked.
 */
import { and, appointments, campaigns, contacts, eq, flows, gte, inArray, messageEvents, messages, openSlots, sql, type Db, type FlowKind } from '@platform/db';
import type { createDiary } from './diary.ts';
import { FLOW_LIBRARY } from './flows.ts';

type Diary = ReturnType<typeof createDiary>;

const DAY = 86_400_000;

/** The part of a day with the most free time. */
type Quiet = { day: string; part: number; open: number; dayOpen: number };

/** How Home splits a day. Salons think in mornings and afternoons, not hours. */
export const DAYPARTS = [
  { label: 'Morning', from: 0, to: 12 },
  { label: 'Midday', from: 12, to: 14 },
  { label: 'Afternoon', from: 14, to: 17 },
  { label: 'Evening', from: 17, to: 24 },
] as const;

export const partOf = (hour: number) => Math.max(0, DAYPARTS.findIndex((p) => hour >= p.from && hour < p.to));

/** A client counts as drifted away after this long without a visit or a booking. */
export const LAPSED_DAYS = 90;

export type Opportunity = {
  kind: 'fill' | 'welcome' | 'rebook' | 'winback' | 'follow_up';
  title: string;
  detail: string;
  /** What it could bring in, in minor units, when every person or slot books. Null without prices. */
  value: number | null;
  note: string;
  action: { label: string; flowId?: string; campaignId?: string };
  people?: { initials: string[]; more: number };
};

const initialsOf = (p: { firstName: string | null; lastName: string | null; email: string }) =>
  ((p.firstName?.[0] ?? p.email[0] ?? '') + (p.lastName?.[0] ?? '')).toUpperCase();

const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
/** Small counts read better as words at the start of a sentence. */
const count = (n: number) => words[n] ?? String(n);
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export function createInsights({
  db,
  diary,
  ensureFlows,
  waitingByKind,
}: {
  db: Db;
  diary: Diary;
  ensureFlows: (tenantId: string) => Promise<unknown>;
  /** How many each flow would email now, so a suggestion's numbers match the flow it opens. */
  waitingByKind: (tenantId: string, now: Date) => Promise<Map<FlowKind, number>>;
}) {
  /** Free and booked time over the next week, by day and part of the day. */
  async function weekAhead(tenantId: string, now: Date) {
    const days = await diary.diaryDays(tenantId, 7, now);
    const tz = days.timezone;
    const end = new Date(now.getTime() + 8 * DAY);
    const rows = await db.execute<{ day: string; hour: number; kind: 'open' | 'booked'; n: number }>(sql`
      select to_char((starts_at at time zone ${tz})::date, 'YYYY-MM-DD') as day, extract(hour from starts_at at time zone ${tz})::int as hour, 'open' as kind, count(*)::int as n
      from ${openSlots} where tenant_id = ${tenantId} and starts_at >= ${now} and starts_at < ${end} group by 1, 2
      union all
      select to_char((starts_at at time zone ${tz})::date, 'YYYY-MM-DD'), extract(hour from starts_at at time zone ${tz})::int, 'booked', count(*)::int
      from ${appointments} where tenant_id = ${tenantId} and status = 'booked' and starts_at >= ${now} and starts_at < ${end} group by 1, 2
    `);
    const grid = new Map(days.days.map((d) => [d.day, DAYPARTS.map(() => ({ open: 0, booked: 0 }))]));
    for (const r of rows.rows) {
      const cell = grid.get(r.day)?.[partOf(Number(r.hour))];
      if (cell) cell[r.kind] += Number(r.n);
    }
    const week = days.days.map((d) => ({ ...d, parts: grid.get(d.day)! }));
    // The quietest stretch: the part of a day with the most free time.
    let quietest: Quiet | null = null as Quiet | null;
    for (const d of week) {
      for (const [part, p] of d.parts.entries()) {
        if (p.open > 0 && (!quietest || p.open > quietest.open)) quietest = { day: d.day, part, open: p.open, dayOpen: d.open };
      }
    }
    return { connected: days.connected, timezone: tz, parts: DAYPARTS.map((p) => p.label), days: week, quietest };
  }

  /** Money booked from email over the period, with the period before it for comparison. */
  async function revenue(tenantId: string, days: number, now: Date) {
    const start = new Date(now.getTime() - days * DAY);
    const bookings = await diary.attributedBookings(tenantId, new Date(start.getTime() - days * DAY), now);
    const daily = Array.from({ length: days }, () => ({ revenue: 0, bookings: 0, previous: 0, previousBookings: 0 }));
    const totals = { revenue: 0, bookings: 0, previous: 0, previousBookings: 0, flows: 0, campaigns: 0 };
    const byFlow = new Map<string, { bookings: number; revenue: number }>();
    for (const b of bookings) {
      const current = b.bookedAt > start;
      const index = Math.min(days - 1, Math.floor((b.bookedAt.getTime() - (current ? start.getTime() : start.getTime() - days * DAY)) / DAY));
      const slot = daily[index]!;
      if (current) {
        slot.revenue += b.price;
        slot.bookings += 1;
        totals.revenue += b.price;
        totals.bookings += 1;
        if (b.flowId) {
          totals.flows += b.price;
          const f = byFlow.get(b.flowId) ?? { bookings: 0, revenue: 0 };
          f.bookings += 1;
          f.revenue += b.price;
          byFlow.set(b.flowId, f);
        } else totals.campaigns += b.price;
      } else {
        slot.previous += b.price;
        slot.previousBookings += 1;
        totals.previous += b.price;
        totals.previousBookings += 1;
      }
    }
    const change = totals.previous > 0 ? Math.round(((totals.revenue - totals.previous) / totals.previous) * 100) : null;
    return { ...totals, change, daily, byFlow };
  }

  /** Each flow's last 30 days: live or not, sends per day, and what it booked. */
  async function flowSummary(tenantId: string, byFlow: Map<string, { bookings: number; revenue: number }>, days: number, now: Date) {
    const rows = await db.select({ id: flows.id, kind: flows.kind, live: flows.live }).from(flows).where(eq(flows.tenantId, tenantId));
    const start = new Date(now.getTime() - days * DAY);
    const sends = rows.length
      ? await db
          .select({ flowId: messages.flowId, index: sql<number>`floor(extract(epoch from ${messages.sentAt} - ${start}) / 86400)::int`, n: sql<number>`count(*)::int` })
          .from(messages)
          .where(and(inArray(messages.flowId, rows.map((r) => r.id)), gte(messages.sentAt, start)))
          .groupBy(sql`1`, sql`2`)
      : [];
    const order: FlowKind[] = ['rebook', 'fill_slots', 'welcome', 'winback'];
    return rows
      .map((r) => {
        const daily = Array.from({ length: days }, () => 0);
        for (const s of sends) if (s.flowId === r.id && s.index >= 0 && s.index < days) daily[s.index] = s.n;
        const result = byFlow.get(r.id) ?? { bookings: 0, revenue: 0 };
        return { id: r.id, kind: r.kind, name: FLOW_LIBRARY[r.kind].name, live: r.live, sent: daily.reduce((a, b) => a + b, 0), daily, ...result };
      })
      .sort((a, b) => Number(b.live) - Number(a.live) || b.revenue - a.revenue || order.indexOf(a.kind) - order.indexOf(b.kind));
  }

  async function averagePrice(tenantId: string, now: Date) {
    const [row] = (
      await db.execute<{ avg: number | null }>(sql`
        select round(avg(price))::int as avg from ${appointments}
        where tenant_id = ${tenantId} and price is not null and status in ('booked', 'completed') and starts_at > ${new Date(now.getTime() - 180 * DAY)}
      `)
    ).rows;
    return row?.avg ? Number(row.avg) : null;
  }

  async function people(ids: string[]) {
    if (!ids.length) return [];
    const rows = await db
      .select({ id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contacts)
      .where(inArray(contacts.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((p) => p !== undefined);
  }

  /** The campaign that booked the most lately, and how many opened it without booking since. */
  async function bestCampaign(tenantId: string, now: Date) {
    const since = new Date(now.getTime() - 90 * DAY);
    const credited = await diary.attributedBookings(tenantId, since, now);
    const totals = new Map<string, { bookings: number; revenue: number }>();
    for (const b of credited) {
      if (!b.campaignId) continue;
      const t = totals.get(b.campaignId) ?? { bookings: 0, revenue: 0 };
      t.bookings += 1;
      t.revenue += b.price;
      totals.set(b.campaignId, t);
    }
    const [id, best] = [...totals].sort((a, b) => b[1].revenue - a[1].revenue || b[1].bookings - a[1].bookings)[0] ?? [];
    if (!id || !best) return null;
    const [campaign] = await db.select({ id: campaigns.id, name: campaigns.name, sentAt: campaigns.sentAt }).from(campaigns).where(eq(campaigns.id, id));
    if (!campaign) return null;
    const [row] = (
      await db.execute<{ n: number }>(sql`
        select count(distinct c.id)::int as n
        from ${messageEvents} e
        join ${messages} m on m.id = e.message_id
        join ${contacts} c on c.tenant_id = m.tenant_id and c.email = m.to_email
        where m.campaign_id = ${id} and e.type = 'open'
          and not exists (select 1 from ${appointments} ap where ap.contact_id = c.id and ap.status <> 'cancelled' and ap.booked_at >= m.sent_at)
      `)
    ).rows;
    return { ...campaign, ...best, openedNotBooked: Number(row?.n ?? 0) };
  }

  /** Up to three things worth doing today, the most time-sensitive and valuable first. */
  async function opportunities(tenantId: string, week: Awaited<ReturnType<typeof weekAhead>>, now: Date): Promise<Opportunity[]> {
    const [flowRows, avg, due, rhythms, best, ready] = await Promise.all([
      db.select({ id: flows.id, kind: flows.kind, live: flows.live }).from(flows).where(eq(flows.tenantId, tenantId)),
      averagePrice(tenantId, now),
      diary.dueSoon(tenantId, 14, now),
      diary.rhythms(tenantId, now),
      bestCampaign(tenantId, now),
      waitingByKind(tenantId, now),
    ]);
    const flow = (kind: FlowKind) => flowRows.find((f) => f.kind === kind);
    const worth = (n: number) => (avg ? avg * n : null);
    const out: (Opportunity & { rank: number })[] = [];

    const q = week.quietest;
    if (q && q.dayOpen >= 2) {
      const fill = flow('fill_slots');
      const dayName = new Date(`${q.day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
      // Name the part of the day when most of the day's free time sits in it.
      const named = q.open * 2 > q.dayOpen;
      const where = named ? `${dayName} ${DAYPARTS[q.part]!.label.toLowerCase()}` : dayName;
      const faces = await people(due.slice(0, 3).map((d) => d.contactId));
      out.push({
        kind: 'fill',
        rank: 0,
        title: `Fill ${where}`,
        detail:
          `${count(named ? q.open : q.dayOpen)} free ${plural(named ? q.open : q.dayOpen, 'slot')}` +
          (due.length
            ? `. ${count(due.length)} ${plural(due.length, 'client is', 'clients are')} due back with nothing booked; we would offer them these times.`
            : '. We would offer them to the clients closest to their next visit.'),
        value: worth(named ? q.open : q.dayOpen),
        note: 'to gain',
        action: fill?.live ? { label: 'See who is in line', flowId: fill.id } : { label: 'Review and switch on', flowId: fill?.id },
        people: { initials: faces.map(initialsOf), more: Math.max(0, due.length - faces.length) },
      });
    }

    const rebook = flow('rebook');
    const dueNow = ready.get('rebook') ?? 0;
    if (rebook && !rebook.live && (dueNow || due.length)) {
      // Lead with the number the flow page will show, so the click-through agrees with Home.
      const later = Math.max(0, due.length - dueNow);
      out.push({
        kind: 'rebook',
        rank: 1,
        title: dueNow
          ? `${count(dueNow)} ${plural(dueNow, 'client is', 'clients are')} ready for a nudge`
          : `${count(due.length)} ${plural(due.length, 'client comes', 'clients come')} due in the next two weeks`,
        detail: dueNow
          ? `Past their usual gap, nothing booked, and happy to hear from you.${later ? ` ${count(later)} more ${plural(later, 'comes', 'come')} due soon.` : ''} Due back sends each one a nudge with free times.`
          : 'They are near their usual gap between visits and have nothing booked. Due back sends each one a nudge with free times as they come due.',
        value: worth(dueNow || due.length),
        note: 'if they each book',
        action: { label: 'Review and switch on', flowId: rebook.id },
      });
    }

    const welcome = flow('welcome');
    if (welcome && !welcome.live) {
      const firstTimers = rhythms.filter((r) => r.visits === 1 && !r.bookedAhead && r.lastVisit && r.lastVisit.getTime() > now.getTime() - 14 * DAY);
      if (firstTimers.length) {
        out.push({
          kind: 'welcome',
          rank: 2,
          title: `${count(firstTimers.length)} ${plural(firstTimers.length, 'first-timer has', 'first-timers have')} not rebooked`,
          detail: 'They came in for the first time in the last fortnight. The thank-you flow sends a warm note a couple of days after every first visit.',
          value: worth(firstTimers.length),
          note: 'if they each book',
          action: { label: 'Review and switch on', flowId: welcome.id },
        });
      }
    }

    const winback = flow('winback');
    if (winback && !winback.live) {
      const lapsed = ready.get('winback') ?? 0;
      if (lapsed >= 3) {
        out.push({
          kind: 'winback',
          rank: 3,
          title: `${count(lapsed)} clients have drifted away`,
          detail: `No visit or booking in ${LAPSED_DAYS} days. We miss you invites them back once, gently.`,
          value: worth(lapsed),
          note: 'if they each book',
          action: { label: 'Review and switch on', flowId: winback.id },
        });
      }
    }

    if (best && best.openedNotBooked > 0) {
      out.push({
        kind: 'follow_up',
        rank: 4,
        title: `${best.name} booked ${best.bookings}`,
        detail: `${money(best.revenue)} from one email. Send a follow-up to the ${best.openedNotBooked} who opened it but have not booked.`,
        value: null,
        note: 'Your best lately',
        action: { label: 'See who opened', campaignId: best.id },
      });
    }

    return out
      .sort((a, b) => (a.kind === 'fill' ? -1 : b.kind === 'fill' ? 1 : (b.value ?? 0) - (a.value ?? 0) || a.rank - b.rank))
      .slice(0, 3)
      .map(({ rank: _rank, ...o }) => o);
  }

  async function overview(tenantId: string, days = 30, now = new Date()) {
    await ensureFlows(tenantId);
    const [money, week] = await Promise.all([revenue(tenantId, days, now), weekAhead(tenantId, now)]);
    const [flowList, todo, due] = await Promise.all([flowSummary(tenantId, money.byFlow, days, now), opportunities(tenantId, week, now), diary.dueSoon(tenantId, 14, now)]);
    const { byFlow: _byFlow, ...revenueOut } = money;
    return { days, revenue: revenueOut, week, dueCount: due.length, opportunities: todo, flows: flowList };
  }

  return { overview };
}

/** Pounds for prose, without pence when it is a round number. */
function money(minor: number) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
}
