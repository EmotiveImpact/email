/**
 * Flows: emails that go by themselves, timed by the diary. A thank-you after a first visit, a nudge
 * when a client is due back, free times on quiet days, and a note to clients who have drifted away.
 *
 * A job runs every hour for each business. Each flow works out who it is for right now, and a
 * client gets each flow's email once per reason (once per visit, once per quiet day), never more
 * than one marketing email in three days, and only in the business's daytime.
 */
import { EmailDoc, fillMergeTags, problems, renderEmail, themeFromBrand, unknownMergeTags } from '@platform/content';
import {
  and,
  contacts,
  desc,
  eq,
  FLOW_KINDS,
  flows,
  flowSends,
  gte,
  inArray,
  messageEvents,
  messages,
  newId,
  openSlots,
  sql,
  suppressions,
  tenants,
  type Db,
  type FlowKind,
} from '@platform/db';
import { parseContent, sampleValues, type CampaignDeps } from './campaigns.ts';
import type { createDiary, Rhythm } from './diary.ts';
import type { Queue } from './queue.ts';
import { isoDay, localHour, noon, sampleSlots, slotLinks, weekday } from './slots.ts';
import { PlatformError } from './types.ts';

type Tenant = typeof tenants.$inferSelect;
type Flow = typeof flows.$inferSelect;
type Diary = ReturnType<typeof createDiary>;

/** Marketing email from one business reaches a client at most once in this many days. */
export const FLOW_GAP_DAYS = 3;
/** Flows only send between these local hours. */
export const SEND_HOURS = { from: 9, to: 19 };
const DAY = 86_400_000;

type Setting = { label: string; min: number; max: number };

/** What each flow is for, its settings and the email it starts with. */
export const FLOW_LIBRARY: Record<
  FlowKind,
  { name: string; description: string; settings: Record<string, number>; fields: Record<string, Setting>; subject: string; content: () => EmailDoc }
> = {
  welcome: {
    name: 'Thank you after a first visit',
    description: 'A warm note a couple of days after someone’s first appointment, with an easy way to book the next one.',
    settings: { delayDays: 2 },
    fields: { delayDays: { label: 'Days after the first visit', min: 0, max: 30 } },
    subject: 'Thank you for coming in, {{first_name|there}}',
    content: () => ({
      version: 1,
      preview: 'We hope you loved it.',
      blocks: [
        { id: 'w1', type: 'heading', text: 'Lovely to meet you', level: 1, align: 'left' },
        {
          id: 'w2',
          type: 'text',
          text: 'Hi {{first_name|there}},\n\nThank you for choosing {{business_name}} for your {{last_service|visit}}. We hope you loved it. If anything was not quite right, reply to this email and tell us.\n\nWhen you are ready for the next one, booking online takes a minute.',
          align: 'left',
        },
        { id: 'w3', type: 'button', label: 'Book your next visit', url: '{{booking_url}}', align: 'left' },
        { id: 'w4', type: 'text', text: 'See you soon,\n{{business_name}}', align: 'left' },
      ],
    }),
  },
  rebook: {
    name: 'Due back',
    description: 'Goes when a client passes the point they usually rebook, worked out from their own visits, with times that are free.',
    settings: { graceDays: 3, firstGapDays: 42 },
    fields: {
      graceDays: { label: 'Days past their usual gap before we nudge', min: 0, max: 30 },
      firstGapDays: { label: 'Usual gap for clients with one visit (days)', min: 7, max: 180 },
    },
    subject: 'Time for your next {{last_service|appointment}}?',
    content: () => ({
      version: 1,
      preview: 'A few times this week that might suit.',
      blocks: [
        { id: 'r1', type: 'heading', text: 'Ready for your next visit?', level: 1, align: 'left' },
        {
          id: 'r2',
          type: 'text',
          text: 'Hi {{first_name|there}},\n\nIt has been {{weeks_since_visit}} weeks since your {{last_service|last visit}}, around the time you usually come back. Pick a time that suits you.',
          align: 'left',
        },
        { id: 'r3', type: 'slots', align: 'left' },
        { id: 'r4', type: 'text', text: 'See you soon,\n{{business_name}}', align: 'left' },
      ],
    }),
  },
  fill_slots: {
    name: 'Fill quiet days',
    description: 'When a day in the next few has gaps, offers those times to clients who are due, a few people per free slot.',
    settings: { leadDays: 1, horizonDays: 3, minOpenSlots: 3, perSlot: 4 },
    fields: {
      leadDays: { label: 'Look from this many days ahead', min: 0, max: 7 },
      horizonDays: { label: 'Up to this many days ahead', min: 1, max: 14 },
      minOpenSlots: { label: 'Only when a day has at least this many free slots', min: 1, max: 50 },
      perSlot: { label: 'Clients to email per free slot', min: 1, max: 20 },
    },
    subject: 'Space on {{slot_day}}, {{first_name|there}}',
    content: () => ({
      version: 1,
      preview: 'A few times have opened up.',
      blocks: [
        { id: 'f1', type: 'heading', text: '{{slot_day}} has space', level: 1, align: 'left' },
        {
          id: 'f2',
          type: 'text',
          text: 'Hi {{first_name|there}},\n\nA few times have opened up on {{slot_day}}. Tap one to book it before someone else does.',
          align: 'left',
        },
        { id: 'f3', type: 'slots', align: 'left' },
        { id: 'f4', type: 'text', text: 'None of these suit? [See the rest of the week]({{booking_url}}).\n\n{{business_name}}', align: 'left' },
      ],
    }),
  },
  winback: {
    name: 'We miss you',
    description: 'For clients who have not been back for a long while, once per lapse. It waits longer for clients who usually leave long gaps.',
    settings: { afterDays: 90 },
    fields: { afterDays: { label: 'Days since their last visit', min: 30, max: 365 } },
    subject: 'It has been a while, {{first_name|there}}',
    content: () => ({
      version: 1,
      preview: 'We would love to see you again.',
      blocks: [
        { id: 'b1', type: 'heading', text: 'We have missed you', level: 1, align: 'left' },
        {
          id: 'b2',
          type: 'text',
          text: 'Hi {{first_name|there}},\n\nIt has been {{weeks_since_visit}} weeks since we last saw you at {{business_name}}. If life got busy, we understand. Whenever you are ready, we would love to have you back.',
          align: 'left',
        },
        { id: 'b3', type: 'button', label: 'Book a visit', url: '{{booking_url}}', align: 'left' },
        { id: 'b4', type: 'text', text: 'Warmly,\n{{business_name}}', align: 'left' },
      ],
    }),
  },
};

/** Every flow setting, so code can read any of them; each flow only uses its own. */
type FlowSettings = { delayDays: number; graceDays: number; firstGapDays: number; leadDays: number; horizonDays: number; minOpenSlots: number; perSlot: number; afterDays: number };
const ALL_SETTINGS = Object.assign({}, ...Object.values(FLOW_LIBRARY).map((f) => f.settings)) as FlowSettings;

type Person = { contactId: string; email: string; firstName: string | null; lastName: string | null };
type Recipient = Person & { reason: string; rhythm: Rhythm };

export type FlowDeps = Pick<CampaignDeps, 'senderFor' | 'sendRate'> & {
  db: Db;
  queue: Queue;
  diary: Diary;
  /** Marketing emails the business's plan has left this month (see billing.ts). */
  emailsLeft: (tenantId: string) => Promise<number>;
};

export function createFlows({ db, queue, senderFor, sendRate, diary, emailsLeft }: FlowDeps) {
  async function tenantById(tenantId: string) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw new PlatformError('not_found', 'No such business.', 404);
    return tenant;
  }

  /** Every business has one of each flow, off until they switch it on. */
  async function ensureFlows(tenantId: string) {
    await db
      .insert(flows)
      .values(FLOW_KINDS.map((kind) => ({ id: newId('flw'), tenantId, kind, subject: FLOW_LIBRARY[kind].subject, content: FLOW_LIBRARY[kind].content(), settings: FLOW_LIBRARY[kind].settings })))
      .onConflictDoNothing();
  }

  async function getFlow(tenantId: string, id: string) {
    const [row] = await db
      .select()
      .from(flows)
      .where(and(eq(flows.tenantId, tenantId), eq(flows.id, id)));
    if (!row) throw new PlatformError('not_found', 'No flow with that id.', 404);
    return row;
  }

  const settingsOf = (flow: Flow) => ({ ...ALL_SETTINGS, ...FLOW_LIBRARY[flow.kind].settings, ...flow.settings }) as FlowSettings;

  /** What stops a flow sending. Empty means it can go live. */
  function flowProblems(tenant: Tenant, flow: Pick<Flow, 'subject' | 'content'>) {
    const doc = parseContent(flow.content);
    const found = [...problems(doc)];
    if (!flow.subject.trim()) found.unshift('Add a subject line.');
    const typos = unknownMergeTags(`${flow.subject} ${JSON.stringify(doc.blocks)}`);
    if (typos.length) found.push(`Unknown merge tag: {{${typos[0]}}}.`);
    if (!tenant.brand.bookingUrl) found.push('Add your booking link in Appearance; these emails point clients to it.');
    if (!tenant.brand.address?.trim()) found.push('Add your postal address in Appearance; it goes at the foot of the email.');
    return found;
  }

  /** Clients who have said yes to news, are not suppressed, and have not had marketing email lately. */
  async function reachable(tenantId: string, now: Date): Promise<Map<string, Person>> {
    const rows = await db
      .select({ contactId: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.marketingConsent, 'granted'),
          sql`not exists (select 1 from ${suppressions} s where s.email = ${contacts.email} and s.scope in (${tenantId}, 'global'))`,
          sql`not exists (select 1 from ${messages} m where m.tenant_id = ${tenantId} and m.to_email = ${contacts.email} and m.stream = 'marketing'
                and m.status not in ('suppressed', 'failed') and m.created_at > ${new Date(now.getTime() - FLOW_GAP_DAYS * DAY)})`,
          sql`exists (select 1 from appointments a where a.contact_id = ${contacts.id})`,
        ),
      );
    return new Map(rows.map((r) => [r.contactId, r]));
  }

  /** The day a fill-slots email would offer, if any: the quietest in the window not offered yet. */
  async function fillDay(tenant: Tenant, flow: Flow, now: Date) {
    const s = settingsOf(flow);
    const { days, connected } = await diary.diaryDays(tenant.id, s.horizonDays + 1, now);
    if (!connected) return null;
    const window = days.slice(s.leadDays, s.horizonDays + 1).filter((d) => d.open >= s.minOpenSlots);
    if (!window.length) return null;
    const offered = await db
      .select({ reason: flowSends.reason })
      .from(flowSends)
      .where(and(eq(flowSends.flowId, flow.id), inArray(flowSends.reason, window.map((d) => `fill:${d.day}`))))
      .groupBy(flowSends.reason);
    const done = new Set(offered.map((o) => o.reason));
    const open = window.filter((d) => !done.has(`fill:${d.day}`));
    return open.sort((a, b) => b.open - a.open || a.day.localeCompare(b.day))[0] ?? null;
  }

  const dueAt = (r: Rhythm, firstGapDays: number) => r.dueAt ?? (r.lastVisit ? new Date(r.lastVisit.getTime() + firstGapDays * DAY) : null);

  /** Who this flow is for right now, before checking what they have already had. */
  async function candidates(tenant: Tenant, flow: Flow, rhythms: Rhythm[], now: Date) {
    const s = settingsOf(flow);
    const t = now.getTime();
    const out: { contactId: string; reason: string; rhythm: Rhythm }[] = [];
    let fill: { day: string; open: number } | null = null;
    for (const r of rhythms) {
      if (!r.lastVisit) continue;
      const last = r.lastVisit.getTime();
      const visit = isoDay(r.lastVisit);
      switch (flow.kind) {
        case 'welcome':
          // A short window, so switching the flow on does not thank everyone who ever came once.
          if (r.visits === 1 && last <= t - s.delayDays * DAY && last > t - (s.delayDays + 7) * DAY) out.push({ contactId: r.contactId, reason: 'welcome', rhythm: r });
          break;
        case 'rebook': {
          const due = dueAt(r, s.firstGapDays)!.getTime() + s.graceDays * DAY;
          // Three weeks after they were due, the win-back flow takes over.
          if (!r.bookedAhead && due <= t && due > t - 21 * DAY) out.push({ contactId: r.contactId, reason: `rebook:${visit}`, rhythm: r });
          break;
        }
        case 'winback': {
          const after = Math.max(s.afterDays, 2 * (r.gapDays ?? 0)) * DAY;
          if (!r.bookedAhead && last <= t - after && last > t - after - 30 * DAY) out.push({ contactId: r.contactId, reason: `winback:${visit}`, rhythm: r });
          break;
        }
        case 'fill_slots':
          break;
      }
    }
    if (flow.kind === 'fill_slots') {
      fill = await fillDay(tenant, flow, now);
      if (fill) {
        const target = noon(fill.day).getTime();
        // Clients due around that day (from two months overdue to two weeks early), closest first.
        const near = rhythms
          .filter((r) => !r.bookedAhead && r.lastVisit)
          .map((r) => ({ r, gap: dueAt(r, ALL_SETTINGS.firstGapDays)!.getTime() - target }))
          .filter(({ gap }) => gap <= 14 * DAY && gap >= -60 * DAY)
          .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap));
        for (const { r } of near) out.push({ contactId: r.contactId, reason: `fill:${fill.day}`, rhythm: r });
      }
    }
    return { list: out, fill, limit: fill ? fill.open * s.perSlot : Infinity };
  }

  /** Candidates narrowed to people who can be emailed and have not had this one yet. */
  async function recipients(tenant: Tenant, flow: Flow, rhythms: Rhythm[], people: Map<string, Person>, now: Date) {
    const { list: all, fill, limit } = await candidates(tenant, flow, rhythms, now);
    const open = all.filter((c) => people.has(c.contactId));
    if (!open.length) return { list: [] as Recipient[], fill };
    const had = await db
      .select({ contactId: flowSends.contactId, reason: flowSends.reason })
      .from(flowSends)
      .where(and(eq(flowSends.flowId, flow.id), inArray(flowSends.contactId, open.map((c) => c.contactId))));
    const sent = new Set(had.map((h) => `${h.contactId} ${h.reason}`));
    const list: Recipient[] = open
      .filter((c) => !sent.has(`${c.contactId} ${c.reason}`))
      .slice(0, limit)
      .map((c) => ({ ...people.get(c.contactId)!, reason: c.reason, rhythm: c.rhythm }));
    return { list, fill };
  }

  /** Free times to show in an email: that day's for fill-slots, otherwise the next fortnight's. */
  async function slotsFor(tenant: Tenant, fillDay: string | null, now: Date) {
    if (fillDay) {
      return slotLinks(await diary.slotsOn(tenant.id, fillDay, tenant.timezone), tenant.timezone, tenant.brand.bookingUrl, { withDay: false });
    }
    const rows = await db
      .select({ startsAt: openSlots.startsAt })
      .from(openSlots)
      .where(and(eq(openSlots.tenantId, tenant.id), gte(openSlots.startsAt, new Date(now.getTime() + 3 * 3600_000)), sql`${openSlots.startsAt} < ${new Date(now.getTime() + 14 * DAY)}`))
      .orderBy(openSlots.startsAt)
      .limit(60);
    return slotLinks(rows, tenant.timezone, tenant.brand.bookingUrl, { withDay: true });
  }

  const valuesFor = (tenant: Tenant, p: Person, rhythm: Rhythm | null, now: Date, slotDay: string) => ({
    first_name: p.firstName,
    last_name: p.lastName,
    email: p.email,
    business_name: tenant.name,
    booking_url: tenant.brand.bookingUrl ?? '',
    last_service: rhythm?.lastService ?? '',
    weeks_since_visit: rhythm?.lastVisit ? String(Math.max(1, Math.round((now.getTime() - rhythm.lastVisit.getTime()) / (7 * DAY)))) : '',
    slot_day: slotDay,
  });

  /**
   * The hourly job for one business: sends what each live flow is due to send. `ignoreHours` is for
   * tests and the "run now" tool; normal runs only send in the daytime.
   */
  async function runFlows(tenantId: string, now = new Date(), options: { ignoreHours?: boolean } = {}) {
    const tenant = await tenantById(tenantId);
    const sent: Partial<Record<FlowKind, number>> = {};
    if (tenant.status === 'paused') return sent;
    const hour = localHour(tenant.timezone, now);
    if (!options.ignoreHours && (hour < SEND_HOURS.from || hour >= SEND_HOURS.to)) return sent;
    const live = await db
      .select()
      .from(flows)
      .where(and(eq(flows.tenantId, tenantId), eq(flows.live, true)));
    if (!live.length) return sent;
    const [rhythms, people] = await Promise.all([diary.rhythms(tenantId, now), reachable(tenantId, now)]);
    const sender = await senderFor(tenant);
    const theme = themeFromBrand(tenant.name, tenant.brand);
    // Over the plan's allowance, flows wait: anyone left out is picked up once there is room again.
    let left = await emailsLeft(tenantId);
    let index = 0;
    // Time-sensitive flows first; whoever gets one is skipped by the rest this run.
    const order: FlowKind[] = ['fill_slots', 'welcome', 'rebook', 'winback'];
    for (const flow of live.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))) {
      if (flowProblems(tenant, flow).length) continue;
      const found = await recipients(tenant, flow, rhythms, people, now);
      const list = found.list.slice(0, Number.isFinite(left) ? left : undefined);
      const { fill } = found;
      if (!list.length) continue;
      const slots = await slotsFor(tenant, fill?.day ?? null, now);
      if (flow.kind === 'fill_slots' && !slots.length) continue;
      const { html, text } = await renderEmail(parseContent(flow.content), theme, { slots });
      const slotDay = fill ? weekday(fill.day) : '';

      const ids = await db.transaction(async (tx) => {
        const claimed = await tx
          .insert(flowSends)
          .values(list.map((r) => ({ id: newId('fsd'), flowId: flow.id, contactId: r.contactId, reason: r.reason })))
          .onConflictDoNothing()
          .returning({ id: flowSends.id, contactId: flowSends.contactId });
        if (!claimed.length) return [];
        const byContact = new Map(list.map((r) => [r.contactId, r]));
        const rows = claimed.map((c) => {
          const r = byContact.get(c.contactId)!;
          const values = valuesFor(tenant, r, r.rhythm, now, slotDay);
          return {
            send: c.id,
            message: {
              id: newId('msg'),
              tenantId,
              flowId: flow.id,
              stream: 'marketing' as const,
              to: r.email,
              from: sender.from,
              replyTo: sender.replyTo,
              subject: fillMergeTags(flow.subject, values, { html: false }),
              html: fillMergeTags(html, values),
              text: fillMergeTags(text, values, { html: false }),
              tags: { flow: flow.id, kind: flow.kind },
            },
          };
        });
        await tx.insert(messages).values(rows.map((r) => r.message));
        await tx.execute(sql`
          update ${flowSends} f set message_id = v.message_id
          from (values ${sql.join(
            rows.map((r) => sql`(${r.send}, ${r.message.id})`),
            sql`, `,
          )}) as v(id, message_id)
          where f.id = v.id`);
        for (const c of claimed) people.delete(c.contactId);
        return rows.map((r) => r.message.id);
      });
      const start = Date.now();
      await queue.enqueueMany(
        'send-message',
        ids.map((messageId) => ({ data: { messageId }, startAfter: new Date(start + (index++ / sendRate) * 1000) })),
      );
      sent[flow.kind] = ids.length;
      left -= ids.length;
    }
    return sent;
  }

  /** Sent, opened, clicked, and the bookings and revenue that followed, per flow. */
  async function flowStats(tenantId: string, flowIds: string[]) {
    const out = new Map(flowIds.map((id) => [id, { sent: 0, opened: 0, clicked: 0, bookings: 0, revenue: 0 }]));
    if (!flowIds.length) return out;
    const [byStatus, byEvent, attribution] = await Promise.all([
      db
        .select({ flowId: messages.flowId, n: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(inArray(messages.flowId, flowIds), sql`${messages.sentAt} is not null`))
        .groupBy(messages.flowId),
      db
        .select({ flowId: messages.flowId, type: messageEvents.type, n: sql<number>`count(distinct ${messageEvents.messageId})::int` })
        .from(messageEvents)
        .innerJoin(messages, eq(messages.id, messageEvents.messageId))
        .where(and(inArray(messages.flowId, flowIds), inArray(messageEvents.type, ['open', 'click'])))
        .groupBy(messages.flowId, messageEvents.type),
      diary.attribution(tenantId),
    ]);
    for (const r of byStatus) out.get(r.flowId!)!.sent = r.n;
    for (const r of byEvent) {
      const s = out.get(r.flowId!)!;
      if (r.type === 'open') s.opened = r.n;
      if (r.type === 'click') s.clicked = r.n;
    }
    for (const [id, v] of attribution.flows) if (out.has(id)) Object.assign(out.get(id)!, v);
    return out;
  }

  /** How many people each flow would email if it ran now (ignoring the hour). */
  async function waiting(tenant: Tenant, rows: Flow[], now: Date) {
    const [rhythms, people] = await Promise.all([diary.rhythms(tenant.id, now), reachable(tenant.id, now)]);
    const out = new Map<string, number>();
    for (const flow of rows) out.set(flow.id, (await recipients(tenant, flow, rhythms, people, now)).list.length);
    return out;
  }

  const describe = (tenant: Tenant, flow: Flow) => ({
    ...flow,
    settings: settingsOf(flow),
    name: FLOW_LIBRARY[flow.kind].name,
    description: FLOW_LIBRARY[flow.kind].description,
    fields: FLOW_LIBRARY[flow.kind].fields,
    problems: flowProblems(tenant, flow),
  });

  async function listFlows(tenantId: string, now = new Date()) {
    const tenant = await tenantById(tenantId);
    await ensureFlows(tenantId);
    const rows = await db.select().from(flows).where(eq(flows.tenantId, tenantId));
    rows.sort((a, b) => FLOW_KINDS.indexOf(a.kind) - FLOW_KINDS.indexOf(b.kind));
    const [stats, due] = await Promise.all([flowStats(tenantId, rows.map((r) => r.id)), waiting(tenant, rows, now)]);
    return rows.map((r) => ({ ...describe(tenant, r), stats: stats.get(r.id)!, waiting: due.get(r.id) ?? 0 }));
  }

  /** Who the flow would email next, and for fill-slots the day and times it would offer. */
  async function nextUp(tenant: Tenant, flow: Flow, now: Date) {
    const [rhythms, people] = await Promise.all([diary.rhythms(tenant.id, now), reachable(tenant.id, now)]);
    const { list, fill } = await recipients(tenant, flow, rhythms, people, now);
    const s = settingsOf(flow);
    const times = fill ? slotLinks(await diary.slotsOn(tenant.id, fill.day, tenant.timezone), tenant.timezone, tenant.brand.bookingUrl, { withDay: false }, 8) : [];
    return {
      total: list.length,
      people: list.slice(0, 5).map((p) => ({
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.email,
        lastService: p.rhythm.lastService,
        lastVisit: p.rhythm.lastVisit,
        dueAt: dueAt(p.rhythm, s.firstGapDays),
      })),
      fill: fill ? { day: fill.day, open: fill.open, times: times.map((t) => t.label) } : null,
    };
  }

  async function flowDetail(tenantId: string, id: string, now = new Date()) {
    const tenant = await tenantById(tenantId);
    const flow = await getFlow(tenantId, id);
    const [stats, next, recent] = await Promise.all([
      flowStats(tenantId, [id]),
      nextUp(tenant, flow, now),
      db
        .select({ email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName, reason: flowSends.reason, at: flowSends.createdAt, status: messages.status })
        .from(flowSends)
        .innerJoin(contacts, eq(contacts.id, flowSends.contactId))
        .leftJoin(messages, eq(messages.id, flowSends.messageId))
        .where(eq(flowSends.flowId, id))
        .orderBy(desc(flowSends.createdAt))
        .limit(20),
    ]);
    const sender = await senderFor(tenant);
    return { ...describe(tenant, flow), stats: stats.get(id)!, waiting: next.total, next, recent, sender: { from: sender.from, own: sender.own } };
  }

  async function updateFlow(tenantId: string, id: string, patch: { subject?: string; content?: unknown; settings?: Record<string, unknown>; live?: boolean }) {
    const tenant = await tenantById(tenantId);
    const current = await getFlow(tenantId, id);
    const fields = FLOW_LIBRARY[current.kind].fields;
    const settings: Record<string, number> = { ...settingsOf(current) };
    for (const [key, raw] of Object.entries(patch.settings ?? {})) {
      const field = fields[key];
      const value = Number(raw);
      if (!field) throw new PlatformError('invalid_request', `This flow has no setting "${key}".`, 422);
      if (!Number.isInteger(value) || value < field.min || value > field.max) {
        throw new PlatformError('invalid_request', `${field.label} must be a whole number from ${field.min} to ${field.max}.`, 422);
      }
      settings[key] = value;
    }
    if (current.kind === 'fill_slots' && settings.horizonDays! < settings.leadDays!) {
      throw new PlatformError('invalid_request', 'The window must end after it starts.', 422);
    }
    const next = {
      subject: patch.subject ?? current.subject,
      content: patch.content === undefined ? current.content : parseContent(patch.content),
    };
    const live = patch.live ?? current.live;
    if (live) {
      const found = flowProblems(tenant, next);
      if (found.length) throw new PlatformError('not_ready', found[0]!, 422);
    }
    const [row] = await db
      .update(flows)
      .set({ ...next, settings, live, updatedAt: new Date() })
      .where(eq(flows.id, id))
      .returning();
    // Switched on: look for clients now (inside sending hours) rather than at the next hourly tick.
    if (live && !current.live) await queue.enqueue('run-flows', { tenantId });
    return describe(tenant, row!);
  }

  /** Puts a flow's email back to how it started. */
  async function resetFlow(tenantId: string, id: string) {
    const current = await getFlow(tenantId, id);
    const library = FLOW_LIBRARY[current.kind];
    return updateFlow(tenantId, id, { subject: library.subject, content: library.content() });
  }

  /** The email as one client would see it, with today's free times, and the day it would offer. */
  async function previewFlow(tenantId: string, id: string, content?: unknown, now = new Date()) {
    const tenant = await tenantById(tenantId);
    const flow = await getFlow(tenantId, id);
    const doc = parseContent(content ?? flow.content);
    const fill = flow.kind === 'fill_slots' ? await fillDay(tenant, flow, now) : null;
    let slots = await slotsFor(tenant, fill?.day ?? null, now);
    if (!slots.length) slots = sampleSlots(tenant.timezone, tenant.brand.bookingUrl, now, flow.kind !== 'fill_slots');
    const { html } = await renderEmail(doc, themeFromBrand(tenant.name, tenant.brand), { slots });
    const values = { ...sampleValues(tenant, 'ama@example.com'), ...(fill && { slot_day: weekday(fill.day) }) };
    return { html: fillMergeTags(html, values).replaceAll('{{unsubscribe_url}}', '#'), slotDay: values.slot_day };
  }

  /** The next free times, for campaigns with a free-times block. */
  const upcomingSlots = (tenant: Tenant) => slotsFor(tenant, null, new Date());

  return { listFlows, getFlow, flowDetail, updateFlow, resetFlow, previewFlow, runFlows, flowStats, ensureFlows, upcomingSlots };
}
