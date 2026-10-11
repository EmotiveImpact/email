/**
 * The diary: appointments and free time from the host app. This is what makes the platform know
 * a salon's week: who is due back, which days are quiet, and which emails led to bookings.
 */
import { and, appEvents, appointments, contacts, desc, eq, gte, inArray, lt, newId, openSlots, sql, tenants, type Db } from '@platform/db';
import { z } from 'zod';
import { PlatformError } from './types.ts';

type Tenant = typeof tenants.$inferSelect;

const when = z.coerce.date();

export const AppointmentInput = z
  .object({
    tenant: z.string().min(1),
    /** Your id for the booking. Sending the same id again updates it. */
    id: z.string().min(1).max(256),
    email: z.email().optional(),
    contactExternalId: z.string().min(1).optional(),
    firstName: z.string().max(256).optional(),
    lastName: z.string().max(256).optional(),
    startsAt: when,
    endsAt: when.optional(),
    service: z.string().max(256).optional(),
    staff: z.string().max(256).optional(),
    /** In minor units: 4500 is £45.00. */
    price: z.number().int().min(0).optional(),
    currency: z.string().length(3).default('GBP'),
    status: z.enum(['booked', 'completed', 'cancelled', 'no_show']).default('booked'),
    /** When the client booked. Defaults to now. */
    bookedAt: when.optional(),
  })
  .refine((v) => v.email || v.contactExternalId, { message: 'Give the client’s email or contactExternalId.' });
export type AppointmentInput = z.input<typeof AppointmentInput>;

export const AvailabilityInput = z.object({
  tenant: z.string().min(1),
  /** The window this list covers; free time already stored inside it is replaced. */
  from: when,
  to: when,
  slots: z
    .array(z.object({ startsAt: when, endsAt: when, staff: z.string().max(256).optional(), service: z.string().max(256).optional() }))
    .max(5000),
});
export type AvailabilityInput = z.input<typeof AvailabilityInput>;

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new PlatformError('invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`, 422);
  }
  return result.data;
}

export type Rhythm = {
  contactId: string;
  visits: number;
  lastVisit: Date | null;
  /** Typical days between visits (the median), when there are at least two. */
  gapDays: number | null;
  /** When they would usually come back. */
  dueAt: Date | null;
  bookedAhead: boolean;
  nextVisit: Date | null;
  lastService: string | null;
};

/** How long after an email a booking still counts as following it. */
export const ATTRIBUTION_DAYS = 5;

export function createDiary(db: Db, getTenant: (appId: string, externalId: string) => Promise<Tenant>) {
  async function contactFor(tenant: Tenant, input: z.output<typeof AppointmentInput>) {
    const byExternal = input.contactExternalId
      ? (await db.select().from(contacts).where(and(eq(contacts.tenantId, tenant.id), eq(contacts.externalId, input.contactExternalId))))[0]
      : undefined;
    if (byExternal) return byExternal;
    if (!input.email) throw new PlatformError('contact_not_found', `No contact with externalId "${input.contactExternalId}". Send their email too.`, 404);
    const email = input.email.trim().toLowerCase();
    const [row] = await db
      .insert(contacts)
      .values({ id: newId('con'), tenantId: tenant.id, email, externalId: input.contactExternalId ?? null, firstName: input.firstName ?? null, lastName: input.lastName ?? null })
      .onConflictDoUpdate({ target: [contacts.tenantId, contacts.email], set: { updatedAt: new Date() } })
      .returning();
    return row!;
  }

  /**
   * A booking from the host app, new or changed. New bookings and cancellations are also recorded as
   * `booking.created` and `booking.cancelled` events, so segments can use them.
   */
  async function upsertAppointment(app: { id: string }, raw: unknown) {
    const input = parse(AppointmentInput, raw);
    const tenant = await getTenant(app.id, input.tenant);
    const contact = await contactFor(tenant, input);
    const [before] = await db
      .select({ status: appointments.status })
      .from(appointments)
      .where(and(eq(appointments.tenantId, tenant.id), eq(appointments.externalId, input.id)));
    const values = {
      contactId: contact.id,
      startsAt: input.startsAt,
      endsAt: input.endsAt ?? null,
      service: input.service ?? null,
      staff: input.staff ?? null,
      price: input.price ?? null,
      currency: input.currency.toUpperCase(),
      status: input.status,
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(appointments)
      .values({ id: newId('apt'), tenantId: tenant.id, externalId: input.id, bookedAt: input.bookedAt ?? new Date(), ...values })
      .onConflictDoUpdate({ target: [appointments.tenantId, appointments.externalId], set: values })
      .returning();
    const properties = { appointmentId: input.id, startsAt: input.startsAt.toISOString(), service: input.service, staff: input.staff, price: input.price };
    if (!before && input.status !== 'cancelled') {
      await db.insert(appEvents).values({ id: newId('evt'), tenantId: tenant.id, contactId: contact.id, name: 'booking.created', properties, occurredAt: row!.bookedAt });
    }
    if (input.status === 'cancelled' && before?.status !== 'cancelled') {
      await db.insert(appEvents).values({ id: newId('evt'), tenantId: tenant.id, contactId: contact.id, name: 'booking.cancelled', properties, occurredAt: new Date() });
    }
    return row!;
  }

  /** Replaces the free time stored for a window with what the host app sees now. */
  async function setAvailability(app: { id: string }, raw: unknown) {
    const input = parse(AvailabilityInput, raw);
    if (input.to <= input.from) throw new PlatformError('invalid_request', '"to" must be after "from".', 422);
    const tenant = await getTenant(app.id, input.tenant);
    const inside = input.slots.filter((s) => s.startsAt >= input.from && s.startsAt < input.to && s.endsAt > s.startsAt);
    await db.transaction(async (tx) => {
      await tx.delete(openSlots).where(and(eq(openSlots.tenantId, tenant.id), gte(openSlots.startsAt, input.from), lt(openSlots.startsAt, input.to)));
      if (inside.length) {
        await tx.insert(openSlots).values(
          inside.map((s) => ({ id: newId('slt'), tenantId: tenant.id, startsAt: s.startsAt, endsAt: s.endsAt, staff: s.staff ?? null, service: s.service ?? null })),
        );
      }
    });
    return { slots: inside.length };
  }

  /** Each client's rhythm, worked out from their visits. */
  async function rhythms(tenantId: string, now = new Date(), contactId?: string): Promise<Rhythm[]> {
    const one = contactId ? sql`and contact_id = ${contactId}` : sql``;
    const rows = await db.execute<{
      contact_id: string;
      visits: number;
      last_visit: string | null;
      gap_seconds: number | null;
      next_visit: string | null;
      last_service: string | null;
    }>(sql`
      with past as (
        select contact_id, starts_at, service,
               lag(starts_at) over (partition by contact_id order by starts_at) as previous
        from ${appointments}
        where tenant_id = ${tenantId} and status in ('booked', 'completed') and starts_at <= ${now} ${one}
      ),
      stats as (
        select contact_id, count(*)::int as visits, max(starts_at) as last_visit,
               percentile_cont(0.5) within group (order by extract(epoch from starts_at - previous))
                 filter (where previous is not null) as gap_seconds,
               (array_agg(service order by starts_at desc))[1] as last_service
        from past group by contact_id
      ),
      ahead as (
        select contact_id, min(starts_at) as next_visit
        from ${appointments}
        where tenant_id = ${tenantId} and status = 'booked' and starts_at > ${now} ${one}
        group by contact_id
      )
      select coalesce(s.contact_id, a.contact_id) as contact_id, coalesce(s.visits, 0) as visits, s.last_visit,
             s.gap_seconds, a.next_visit, s.last_service
      from stats s full join ahead a on a.contact_id = s.contact_id
    `);
    return rows.rows.map((r) => {
      const lastVisit = r.last_visit ? new Date(r.last_visit) : null;
      const gapDays = r.gap_seconds && r.visits >= 2 ? Math.max(1, Math.round(Number(r.gap_seconds) / 86_400)) : null;
      return {
        contactId: r.contact_id,
        visits: Number(r.visits),
        lastVisit,
        gapDays,
        dueAt: lastVisit && gapDays ? new Date(lastVisit.getTime() + gapDays * 86_400_000) : null,
        bookedAhead: Boolean(r.next_visit),
        nextVisit: r.next_visit ? new Date(r.next_visit) : null,
        lastService: r.last_service,
      };
    });
  }

  async function rhythmFor(tenantId: string, contactId: string, now = new Date()) {
    return (await rhythms(tenantId, now, contactId))[0] ?? null;
  }

  /** Booked and free time for each of the next `days` days, in the business's time zone. */
  async function diaryDays(tenantId: string, days = 7, now = new Date()) {
    const [tenant] = await db.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId));
    const tz = tenant?.timezone ?? 'Europe/London';
    const end = new Date(now.getTime() + (days + 1) * 86_400_000);
    const rows = await db.execute<{ day: string; open: number; booked: number }>(sql`
      with days as (
        select (generate_series((${now}::timestamptz at time zone ${tz})::date, (${now}::timestamptz at time zone ${tz})::date + ${days - 1}::int, interval '1 day'))::date as day
      ),
      free as (
        select (starts_at at time zone ${tz})::date as day, count(*)::int as n from ${openSlots}
        where tenant_id = ${tenantId} and starts_at >= ${now} and starts_at < ${end} group by 1
      ),
      taken as (
        select (starts_at at time zone ${tz})::date as day, count(*)::int as n from ${appointments}
        where tenant_id = ${tenantId} and status = 'booked' and starts_at >= ${now} and starts_at < ${end} group by 1
      )
      select to_char(d.day, 'YYYY-MM-DD') as day, coalesce(f.n, 0) as open, coalesce(t.n, 0) as booked
      from days d left join free f on f.day = d.day left join taken t on t.day = d.day
      order by d.day
    `);
    const [{ any } = { any: false }] = (
      await db.execute<{ any: boolean }>(sql`select exists (select 1 from ${openSlots} where tenant_id = ${tenantId}) as any`)
    ).rows;
    return { connected: Boolean(any), timezone: tz, days: rows.rows.map((r) => ({ day: r.day, open: Number(r.open), booked: Number(r.booked) })) };
  }

  /** Free slots on one day (in the business's time zone), earliest first. */
  async function slotsOn(tenantId: string, day: string, tz: string) {
    return db
      .select()
      .from(openSlots)
      .where(and(eq(openSlots.tenantId, tenantId), sql`(${openSlots.startsAt} at time zone ${tz})::date = ${day}::date`, gte(openSlots.startsAt, new Date())))
      .orderBy(openSlots.startsAt);
  }

  /**
   * Bookings and revenue that followed an email. Each booking counts once, for the last marketing
   * email the client got in the five days before they booked.
   */
  async function attribution(tenantId: string, sinceDays = 90) {
    const rows = await db.execute<{ campaign_id: string | null; flow_id: string | null; bookings: number; revenue: number }>(sql`
      select lt.campaign_id, lt.flow_id, count(*)::int as bookings, coalesce(sum(ap.price), 0)::int as revenue
      from ${appointments} ap
      join ${contacts} c on c.id = ap.contact_id
      cross join lateral (
        select m.campaign_id, m.flow_id from messages m
        where m.tenant_id = ap.tenant_id and m.to_email = c.email and m.stream = 'marketing' and m.sent_at is not null
          and m.status not in ('bounced', 'failed', 'rejected', 'suppressed')
          and m.sent_at <= ap.booked_at and m.sent_at > ap.booked_at - make_interval(days => ${ATTRIBUTION_DAYS})
          and (m.campaign_id is not null or m.flow_id is not null)
        order by m.sent_at desc limit 1
      ) lt
      where ap.tenant_id = ${tenantId} and ap.status <> 'cancelled' and ap.booked_at > now() - make_interval(days => ${sinceDays})
      group by lt.campaign_id, lt.flow_id
    `);
    const campaigns = new Map<string, { bookings: number; revenue: number }>();
    const flows = new Map<string, { bookings: number; revenue: number }>();
    for (const r of rows.rows) {
      const v = { bookings: Number(r.bookings), revenue: Number(r.revenue) };
      if (r.campaign_id) campaigns.set(r.campaign_id, v);
      if (r.flow_id) flows.set(r.flow_id, v);
    }
    return { campaigns, flows };
  }

  /** A client's recent and upcoming appointments, newest first. */
  async function appointmentsFor(tenantId: string, contactId: string, limit = 20) {
    return db
      .select()
      .from(appointments)
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.contactId, contactId)))
      .orderBy(desc(appointments.startsAt))
      .limit(limit);
  }

  /** Clients due back in the next `days` days (or overdue by up to three weeks) with nothing booked. */
  async function dueSoon(tenantId: string, days = 7, now = new Date()) {
    const all = await rhythms(tenantId, now);
    const due = all
      .filter((r) => r.dueAt && !r.bookedAhead && r.dueAt.getTime() <= now.getTime() + days * 86_400_000 && r.dueAt.getTime() > now.getTime() - 21 * 86_400_000)
      .sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime());
    if (!due.length) return [];
    const people = await db
      .select({ id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contacts)
      .where(inArray(contacts.id, due.map((r) => r.contactId)));
    const byId = new Map(people.map((p) => [p.id, p]));
    return due.map((r) => ({ ...r, contact: byId.get(r.contactId)! }));
  }

  return { upsertAppointment, setAvailability, rhythms, rhythmFor, diaryDays, slotsOn, attribution, appointmentsFor, dueSoon };
}
