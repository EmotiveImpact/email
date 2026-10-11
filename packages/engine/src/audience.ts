/**
 * Contacts, their history, and segments: saved rules that pick contacts, worked out in SQL when
 * used so a segment is never stale.
 */
import {
  and,
  appEvents,
  apps,
  asc,
  consents,
  contacts,
  desc,
  eq,
  messages,
  newId,
  segments,
  sql,
  suppressions,
  tenants,
  type Db,
} from '@platform/db';
import { z } from 'zod';
import { PlatformError } from './types.ts';

// ---------------------------------------------------------------- segment rules

const days = z.number().int().min(1).max(3650);

export const Condition = z.discriminatedUnion('type', [
  /** Their latest marketing consent. */
  z.object({ type: z.literal('consent'), is: z.enum(['granted', 'withdrawn', 'unknown']) }),
  /** A field your app sent with the contact, such as "treatment" or "stylist". */
  z.object({
    type: z.literal('attribute'),
    key: z.string().min(1).max(64),
    op: z.enum(['equals', 'not_equals', 'contains', 'exists', 'not_exists', 'more_than', 'less_than']),
    value: z.union([z.string().max(200), z.number()]).optional(),
  }),
  /** How often something happened, e.g. at least 3 "booking.created" in the last 180 days. */
  z.object({
    type: z.literal('event'),
    name: z.string().min(1).max(100),
    op: z.enum(['at_least', 'none']),
    count: z.number().int().min(1).max(1000).default(1),
    withinDays: days.optional(),
  }),
  /** When it last happened, e.g. last "booking.created" more than 42 days ago. */
  z.object({
    type: z.literal('last_event'),
    name: z.string().min(1).max(100),
    op: z.enum(['more_than_days_ago', 'within_days']),
    days,
  }),
  /** When they were added. */
  z.object({ type: z.literal('added'), op: z.enum(['within_days', 'more_than_days_ago']), days }),
  z.object({ type: z.literal('email'), op: z.enum(['contains', 'ends_with']), value: z.string().min(1).max(200) }),
]);
export type Condition = z.output<typeof Condition>;

export const SegmentDefinition = z.object({
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(Condition).max(20).default([]),
});
export type SegmentDefinition = z.output<typeof SegmentDefinition>;
export type SegmentDefinitionInput = z.input<typeof SegmentDefinition>;

const ago = (n: number) => sql`now() - make_interval(days => ${n})`;
const like = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** One condition as a SQL predicate over `contacts`. Values are always bound, never spliced. */
function compileCondition(c: Condition) {
  switch (c.type) {
    case 'consent':
      return sql`${contacts.marketingConsent} = ${c.is}`;
    case 'attribute': {
      const field = sql`(${contacts.attributes} ->> ${c.key})`;
      const number = sql`(case when ${field} ~ '^-?[0-9]+(\\.[0-9]+)?$' then ${field}::numeric end)`;
      if (c.op === 'exists') return sql`${contacts.attributes} ? ${c.key}`;
      if (c.op === 'not_exists') return sql`not (${contacts.attributes} ? ${c.key})`;
      if (c.value === undefined) throw new PlatformError('invalid_request', `The "${c.key}" rule needs a value.`, 422);
      if (c.op === 'equals') return sql`lower(${field}) = lower(${String(c.value)})`;
      if (c.op === 'not_equals') return sql`${field} is distinct from ${String(c.value)}`;
      if (c.op === 'contains') return sql`${field} ilike ${like(String(c.value))}`;
      if (c.op === 'more_than') return sql`${number} > ${Number(c.value)}`;
      return sql`${number} < ${Number(c.value)}`;
    }
    case 'event': {
      const within = c.withinDays ? sql`and ${appEvents.occurredAt} >= ${ago(c.withinDays)}` : sql``;
      const counted = sql`(select count(*) from ${appEvents} where ${appEvents.contactId} = ${contacts.id} and ${appEvents.name} = ${c.name} ${within})`;
      return c.op === 'none' ? sql`${counted} = 0` : sql`${counted} >= ${c.count}`;
    }
    case 'last_event': {
      const last = sql`(select max(${appEvents.occurredAt}) from ${appEvents} where ${appEvents.contactId} = ${contacts.id} and ${appEvents.name} = ${c.name})`;
      return c.op === 'within_days' ? sql`${last} >= ${ago(c.days)}` : sql`${last} < ${ago(c.days)}`;
    }
    case 'added':
      return c.op === 'within_days' ? sql`${contacts.createdAt} >= ${ago(c.days)}` : sql`${contacts.createdAt} < ${ago(c.days)}`;
    case 'email':
      return c.op === 'contains'
        ? sql`${contacts.email} ilike ${like(c.value)}`
        : sql`${contacts.email} ilike ${`%${c.value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}`}`;
  }
}

/** The whole definition as one predicate; no conditions means everyone. */
export function compileSegment(definition: SegmentDefinition) {
  if (definition.conditions.length === 0) return sql`true`;
  const parts = definition.conditions.map((c) => sql`(${compileCondition(c)})`);
  return sql.join(parts, definition.match === 'all' ? sql` and ` : sql` or `);
}

/** Ready-made segments a new business starts with. */
export const STARTER_SEGMENTS: { name: string; definition: z.input<typeof SegmentDefinition> }[] = [
  { name: 'Happy to hear news', definition: { conditions: [{ type: 'consent', is: 'granted' }] } },
  {
    name: 'Regulars',
    definition: { conditions: [{ type: 'event', name: 'booking.created', op: 'at_least', count: 3, withinDays: 180 }] },
  },
  {
    name: 'Due for a visit',
    definition: { conditions: [{ type: 'last_event', name: 'booking.created', op: 'more_than_days_ago', days: 42 }] },
  },
  { name: 'New this month', definition: { conditions: [{ type: 'added', op: 'within_days', days: 30 }] } },
];

// ---------------------------------------------------------------- the module

export function parseDefinition(raw: unknown): SegmentDefinition {
  const result = SegmentDefinition.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new PlatformError('invalid_request', `${issue.path.join('.') || 'definition'}: ${issue.message}`, 422);
  }
  return result.data;
}

export const ContactInput = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export function createAudience(db: Db) {
  async function tenantsForAccount(accountId: string) {
    return db
      .select({ tenant: tenants, appName: apps.name })
      .from(tenants)
      .innerJoin(apps, eq(apps.id, tenants.appId))
      .where(eq(apps.accountId, accountId))
      .orderBy(asc(tenants.name));
  }

  /** A tenant, only if it belongs to the account. Dashboards address tenants by internal id. */
  async function tenantInAccount(accountId: string, tenantId: string) {
    const [row] = await db
      .select({ tenant: tenants })
      .from(tenants)
      .innerJoin(apps, eq(apps.id, tenants.appId))
      .where(and(eq(tenants.id, tenantId), eq(apps.accountId, accountId)));
    if (!row) throw new PlatformError('not_found', 'No business with that id in this account.', 404);
    return row.tenant;
  }

  async function listContacts(
    tenantId: string,
    options: { search?: string; consent?: 'granted' | 'withdrawn' | 'unknown'; segment?: SegmentDefinition; limit?: number; offset?: number } = {},
  ) {
    const filters = [eq(contacts.tenantId, tenantId)];
    if (options.search?.trim()) {
      const q = like(options.search.trim());
      filters.push(
        sql`(${contacts.email} ilike ${q} or ${contacts.firstName} ilike ${q} or ${contacts.lastName} ilike ${q} or concat_ws(' ', ${contacts.firstName}, ${contacts.lastName}) ilike ${q})`,
      );
    }
    if (options.consent) filters.push(eq(contacts.marketingConsent, options.consent));
    if (options.segment) filters.push(compileSegment(options.segment));
    const where = and(...filters);
    // Spelled out: Drizzle leaves columns unqualified inside a select list, which would be ambiguous here.
    const lastEvent = sql<string | null>`(select max(e.occurred_at) from app_events e where e.contact_id = "contacts"."id")`;
    const [rows, [total]] = await Promise.all([
      db
        .select({ contact: contacts, lastActivityAt: lastEvent })
        .from(contacts)
        .where(where)
        .orderBy(desc(contacts.updatedAt), desc(contacts.id))
        .limit(Math.min(options.limit ?? 50, 200))
        .offset(options.offset ?? 0),
      db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(where),
    ]);
    return { total: total!.n, contacts: rows.map((r) => ({ ...r.contact, lastActivityAt: r.lastActivityAt })) };
  }

  /** Everything about one person: consent history, what they did, what we sent, and any block. */
  async function contactDetail(tenantId: string, contactId: string) {
    const [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, tenantId)));
    if (!contact) throw new PlatformError('not_found', 'No contact with that id.', 404);
    const [history, events, sent, blocks] = await Promise.all([
      db.select().from(consents).where(eq(consents.contactId, contact.id)).orderBy(desc(consents.recordedAt)).limit(50),
      db.select().from(appEvents).where(eq(appEvents.contactId, contact.id)).orderBy(desc(appEvents.occurredAt)).limit(50),
      db
        .select({ id: messages.id, subject: messages.subject, stream: messages.stream, status: messages.status, createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.tenantId, tenantId), eq(messages.to, contact.email)))
        .orderBy(desc(messages.createdAt))
        .limit(50),
      db
        .select({ reason: suppressions.reason, stream: suppressions.stream, scope: suppressions.scope, createdAt: suppressions.createdAt })
        .from(suppressions)
        .where(and(eq(suppressions.email, contact.email), sql`${suppressions.scope} in (${tenantId}, 'global')`)),
    ]);
    return { contact, consents: history, events, messages: sent, suppressions: blocks };
  }

  async function addContact(tenantId: string, raw: unknown, consent?: { marketing: 'granted' | 'withdrawn'; source: string }) {
    const parsed = ContactInput.safeParse(raw);
    if (!parsed.success) throw new PlatformError('invalid_request', parsed.error.issues[0]!.message, 422);
    const input = parsed.data;
    const set = {
      ...(input.firstName !== undefined && { firstName: input.firstName }),
      ...(input.lastName !== undefined && { lastName: input.lastName }),
      ...(input.attributes !== undefined && { attributes: input.attributes }),
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(contacts)
      .values({ id: newId('ctc'), tenantId, email: input.email, ...set })
      .onConflictDoUpdate({ target: [contacts.tenantId, contacts.email], set })
      .returning();
    if (consent) {
      await db.insert(consents).values({ id: newId('cns'), tenantId, contactId: row!.id, status: consent.marketing, source: consent.source, recordedAt: new Date() });
      await db.update(contacts).set({ marketingConsent: consent.marketing }).where(eq(contacts.id, row!.id));
    }
    return row!;
  }

  // ---------------------------------------------------------------- segments

  async function listSegments(tenantId: string) {
    const rows = await db.select().from(segments).where(eq(segments.tenantId, tenantId)).orderBy(asc(segments.createdAt));
    return Promise.all(rows.map(async (s) => ({ ...s, size: await countSegment(tenantId, parseDefinition(s.definition)) })));
  }

  async function getSegment(tenantId: string, segmentId: string) {
    const [row] = await db
      .select()
      .from(segments)
      .where(and(eq(segments.id, segmentId), eq(segments.tenantId, tenantId)));
    if (!row) throw new PlatformError('not_found', 'No segment with that id.', 404);
    return row;
  }

  async function countSegment(tenantId: string, definition: SegmentDefinition) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), compileSegment(definition)));
    return row!.n;
  }

  async function saveSegment(tenantId: string, input: { id?: string; name: string; definition: unknown }) {
    const definition = parseDefinition(input.definition);
    const name = input.name?.trim();
    if (!name) throw new PlatformError('invalid_request', 'Give the segment a name.', 422);
    if (input.id) {
      await getSegment(tenantId, input.id);
      const [row] = await db
        .update(segments)
        .set({ name, definition, updatedAt: new Date() })
        .where(eq(segments.id, input.id))
        .returning();
      return row!;
    }
    const [row] = await db.insert(segments).values({ id: newId('seg'), tenantId, name, definition }).returning();
    return row!;
  }

  async function deleteSegment(tenantId: string, segmentId: string) {
    await getSegment(tenantId, segmentId);
    await db.delete(segments).where(eq(segments.id, segmentId));
  }

  /** Gives a business the starter segments, once. */
  async function ensureStarterSegments(tenantId: string) {
    const [existing] = await db.select({ n: sql<number>`count(*)::int` }).from(segments).where(eq(segments.tenantId, tenantId));
    if (existing!.n > 0) return;
    await db.insert(segments).values(
      STARTER_SEGMENTS.map((s) => ({ id: newId('seg'), tenantId, name: s.name, definition: parseDefinition(s.definition) })),
    );
  }

  /** Distinct event names and attribute keys seen for a tenant, for the segment builder's menus. */
  async function vocabulary(tenantId: string) {
    const [events, keys] = await Promise.all([
      db
        .selectDistinct({ name: appEvents.name })
        .from(appEvents)
        .where(eq(appEvents.tenantId, tenantId))
        .orderBy(asc(appEvents.name))
        .limit(100),
      db.execute<{ key: string }>(
        sql`select distinct jsonb_object_keys(${contacts.attributes}) as key from ${contacts} where ${contacts.tenantId} = ${tenantId} order by 1 limit 100`,
      ),
    ]);
    return { events: events.map((e) => e.name), attributes: keys.rows.map((k) => k.key) };
  }

  return {
    tenantsForAccount,
    tenantInAccount,
    listContacts,
    contactDetail,
    addContact,
    listSegments,
    getSegment,
    countSegment,
    saveSegment,
    deleteSegment,
    ensureStarterSegments,
    vocabulary,
  };
}

export type Audience = ReturnType<typeof createAudience>;
