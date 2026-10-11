import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  accounts,
  apiKeys,
  apps,
  appEvents,
  appointments,
  consents,
  contacts,
  flowSends,
  flows,
  messageEvents,
  messages,
  newId,
  suppressions,
  tenants,
  webhookDeliveries,
  webhookEndpoints,
  type Brand,
  type Db,
  type MessageStatus,
} from '@platform/db';
import { and, desc, eq, inArray, isNull, or, sql } from '@platform/db';
import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import { createAssets } from './assets.ts';
import { createAudience } from './audience.ts';
import { createBilling, SamplePaymentProvider, type PaymentProvider } from './billing.ts';
import { createCampaigns } from './campaigns.ts';
import { createDiary } from './diary.ts';
import { createDomains, parseFrom } from './domains.ts';
import { createLimits, LIMITS } from './limits.ts';
import { assertPublicUrl, resolveHost, type ResolveHost } from './safe-url.ts';
import { createFlows } from './flows.ts';
import { PgAssetStore, SampleImageGenerator, type AssetStore, type ImageGenerator } from './images.ts';
import { createInsights } from './insights.ts';
import { createOnboarding } from './onboarding.ts';
import { LocalProvisioner, type Provisioner } from './provisioning.ts';
import { createStudio } from './studio.ts';
import type { JobName, Jobs, Queue } from './queue.ts';
import { parseSesEvent, type SesEvent } from './ses-events.ts';
import { PermanentSendError, PlatformError, type Transport } from './types.ts';

export type EngineConfig = {
  /** Public base URL of the API, used for unsubscribe links. */
  publicUrl: string;
  /** Secret for signing unsubscribe tokens. */
  signingSecret: string;
  /** Used when a tenant has no from address of its own. */
  defaultFrom: string;
  /** Emails per second the SES account allows; campaigns are paced to stay under it. Default 10. */
  sendRate?: number;
  /** Only send from domains a business has verified. On in production; off for local work. */
  verifiedDomainsOnly?: boolean;
  /** Generated pictures each business may make a day. Default 40. */
  imagesPerDay?: number;
};

/** Pause a business before SES would act on the whole account: lower than SES's review levels. */
export const REPUTATION_LIMITS = { minimumSends: 200, bounceRate: 0.04, complaintRate: 0.002, windowDays: 7 };

type Tenant = typeof tenants.$inferSelect;
type Message = typeof messages.$inferSelect;
type App = typeof apps.$inferSelect;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email());

export const SendEmailInput = z
  .object({
    tenant: z.string().min(1),
    stream: z.enum(['transactional', 'marketing']).default('transactional'),
    to: email,
    from: z
      .string()
      .trim()
      .refine((v) => parseFrom(v) !== null, 'Give "from" as an address, or a name and an address like Linden Studio <hello@linden.co.uk>.')
      .optional(),
    replyTo: email.optional(),
    subject: z.string().trim().min(1).max(998),
    html: z.string().max(5_000_000).optional(),
    text: z.string().max(1_000_000).optional(),
    tags: z.record(z.string().max(64), z.string().max(256)).default({}),
    idempotencyKey: z.string().min(1).max(256).optional(),
  })
  .refine((v) => v.html || v.text, { message: 'Give html, text or both.' });
export type SendEmailInput = z.input<typeof SendEmailInput>;

export const UpsertContactInput = z.object({
  tenant: z.string().min(1),
  email,
  externalId: z.string().max(256).optional(),
  firstName: z.string().max(256).optional(),
  lastName: z.string().max(256).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  consent: z
    .object({
      marketing: z.enum(['granted', 'withdrawn']),
      source: z.string().min(1).max(256),
      recordedAt: z.coerce.date().optional(),
    })
    .optional(),
});
export type UpsertContactInput = z.input<typeof UpsertContactInput>;

export const RecordEventInput = z.object({
  tenant: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9_.-]+$/i, 'Use letters, numbers, dots, dashes and underscores.'),
  email: email.optional(),
  contactExternalId: z.string().max(256).optional(),
  properties: z.record(z.string(), z.unknown()).default({}),
  occurredAt: z.coerce.date().optional(),
});
export type RecordEventInput = z.input<typeof RecordEventInput>;

function isTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const UpsertTenantInput = z.object({
  name: z.string().trim().min(1).max(256),
  fromEmail: z.string().trim().min(3).optional(),
  replyTo: email.optional(),
  sesTenant: z.string().max(64).optional(),
  brand: z
    .object({
      accent: z
        .string()
        .regex(/^#[0-9a-f]{6}$/i)
        .optional(),
      rail: z.enum(['light', 'pigment']).optional(),
      headingFont: z.enum(['cal-sans', 'geist', 'serif']).optional(),
      logoUrl: z.url().optional(),
      address: z.string().max(300).optional(),
      bookingUrl: z.url().optional(),
      reviewUrl: z.url().optional(),
    })
    .optional(),
  /** IANA time zone, such as Europe/London. Flows send in the business's daytime. */
  timezone: z
    .string()
    .refine(isTimeZone, 'Use an IANA time zone such as Europe/London.')
    .optional(),
});
export type UpsertTenantInput = z.input<typeof UpsertTenantInput>;

/** Webhook event types an app can subscribe to. */
export const WEBHOOK_EVENTS = [
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.complained',
  'email.rejected',
  'email.failed',
  'email.opened',
  'email.clicked',
  'contact.unsubscribed',
  'domain.verified',
  'tenant.paused',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// Statuses only move forward, so a late "delivered" never hides an earlier bounce.
const RANK: Record<MessageStatus, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivery_delayed: 3,
  delivered: 4,
  bounced: 5,
  complained: 5,
  rejected: 5,
  failed: 5,
  suppressed: 5,
};

const SES_STATUS: Partial<Record<SesEvent['type'], MessageStatus>> = {
  delivery: 'delivered',
  delivery_delay: 'delivery_delayed',
  bounce: 'bounced',
  complaint: 'complained',
  reject: 'rejected',
  rendering_failure: 'failed',
};

const SES_WEBHOOK: Partial<Record<SesEvent['type'], WebhookEvent>> = {
  delivery: 'email.delivered',
  delivery_delay: 'email.delivery_delayed',
  bounce: 'email.bounced',
  complaint: 'email.complained',
  reject: 'email.rejected',
  rendering_failure: 'email.failed',
  open: 'email.opened',
  click: 'email.clicked',
};

/** A readable, unique slug: "Linden Studio" → "linden-studio-7k2q". */
export function slugify(name: string, id: string) {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || 'account'}-${id.slice(-4)}`;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    throw new PlatformError('invalid_request', `${where}${issue.message}`, 422);
  }
  return result.data;
}

const UNSUBSCRIBE_HTML =
  '<p style="font:12px/1.5 Arial,sans-serif;color:#6b6b6b;text-align:center;margin:24px 0 0">Don’t want these emails? <a href="{{unsubscribe_url}}" style="color:#6b6b6b">Unsubscribe</a></p>';

export function createEngine(deps: {
  db: Db;
  transport: Transport;
  queue: Queue;
  config: EngineConfig;
  fetch?: typeof fetch;
  provisioner?: Provisioner;
  resolveTxt?: (name: string) => Promise<string[][]>;
  /** Looks up a webhook host's addresses, to refuse private ones. Default: DNS. */
  resolveHost?: ResolveHost;
  /** Where picture files live. Default: Postgres, served by the API. */
  assetStore?: AssetStore;
  /** Makes pictures from prompts. Default: soft sample pictures, no provider needed. */
  imageGenerator?: ImageGenerator;
  /** Takes payment for plans. Default: the sample provider (no money). Null switches payments off. */
  paymentProvider?: PaymentProvider | null;
}) {
  const { db, transport, queue, config } = deps;
  const doFetch = deps.fetch ?? fetch;
  const resolve = deps.resolveHost ?? resolveHost;
  const domainsApi = createDomains({
    db,
    queue,
    provisioner: deps.provisioner ?? new LocalProvisioner(),
    defaultFrom: config.defaultFrom,
    verifiedDomainsOnly: config.verifiedDomainsOnly ?? false,
    resolveTxt: deps.resolveTxt,
    onVerified: (domain) => emit(domain.tenantId, 'domain.verified', null, { domain: domain.domain }),
  });
  const sendRate = config.sendRate ?? 10;
  const diary = createDiary(db, getTenant);
  const studioApi = createStudio(db);
  const limitsApi = createLimits(db);
  const billingApi = createBilling({ db, provider: deps.paymentProvider === undefined ? new SamplePaymentProvider() : deps.paymentProvider });
  const flowsApi = createFlows({ db, queue, senderFor: domainsApi.senderFor, sendRate, diary, emailsLeft: billingApi.emailsLeft });
  const assetsApi = createAssets({
    db,
    store: deps.assetStore ?? new PgAssetStore(db, config.publicUrl),
    generator: deps.imageGenerator ?? new SampleImageGenerator(),
    imagesPerDay: config.imagesPerDay ?? 40,
    picturesLeft: billingApi.picturesLeft,
  });
  const onboardingApi = createOnboarding({ db, diary });
  const insights = createInsights({ db, diary, ensureFlows: flowsApi.ensureFlows });
  const campaignsApi = createCampaigns({ db, queue, senderFor: domainsApi.senderFor, sendRate, diary, upcomingSlots: flowsApi.upcomingSlots, sendingProblem: billingApi.sendingProblem });

  // ---------------------------------------------------------------- accounts, apps and keys

  /** An account and a partner app, made by us (the seed, tests, or setting up Saleane and Caleane). */
  async function createAccountWithApp(input: { account: string; app: string }) {
    const accountId = newId('acc');
    const appId = newId('app');
    await db.transaction(async (tx) => {
      await tx.insert(accounts).values({ id: accountId, name: input.account, slug: slugify(input.account, accountId) });
      await tx.insert(apps).values({ id: appId, accountId, name: input.app, partner: true });
    });
    return { accountId, appId };
  }

  /** Adds an app (a product that sends) to an existing account. */
  async function createApp(accountId: string, name: string, options: { direct?: boolean; partner?: boolean } = {}) {
    const [row] = await db.insert(apps).values({ id: newId('app'), accountId, name, direct: options.direct ?? false, partner: options.partner ?? false }).returning();
    return row!;
  }

  /** Creates an API key. The full key is returned once and never stored. */
  async function createApiKey(appId: string, name: string) {
    const key = `pk_live_${randomBytes(24).toString('base64url')}`;
    const id = newId('key');
    await db.insert(apiKeys).values({ id, appId, name, prefix: key.slice(0, 12), hash: sha256(key) });
    return { id, key };
  }

  async function appInAccount(accountId: string, appId: string) {
    const [row] = await db.select().from(apps).where(and(eq(apps.id, appId), eq(apps.accountId, accountId)));
    if (!row) throw new PlatformError('not_found', 'No such app in this account.', 404);
    return row;
  }

  /** The account's apps, each with its live keys (never the keys themselves, only their start). */
  async function listApps(accountId: string) {
    const rows = await db.select().from(apps).where(eq(apps.accountId, accountId)).orderBy(desc(apps.direct), apps.createdAt);
    const keys = rows.length
      ? await db
          .select({ id: apiKeys.id, appId: apiKeys.appId, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt })
          .from(apiKeys)
          .where(and(inArray(apiKeys.appId, rows.map((r) => r.id)), isNull(apiKeys.revokedAt)))
          .orderBy(apiKeys.createdAt)
      : [];
    return rows.map((app) => ({
      id: app.id,
      name: app.name,
      direct: app.direct,
      embedOrigins: app.embedOrigins,
      keys: keys.filter((k) => k.appId === app.id).map(({ appId: _, ...k }) => k),
    }));
  }

  /** Adds an app such as Saleane, for its server to call the API with its own keys. */
  async function addApp(accountId: string, raw: unknown) {
    const name = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(raw);
    if (!name.success) throw new PlatformError('invalid_request', 'Give the app a name.', 422);
    const app = await createApp(accountId, name.data.name);
    return (await listApps(accountId)).find((a) => a.id === app.id)!;
  }

  async function addApiKey(accountId: string, appId: string, raw: unknown) {
    await appInAccount(accountId, appId);
    const name = z.object({ name: z.string().trim().max(80).default('') }).safeParse(raw ?? {});
    const created = await createApiKey(appId, (name.success && name.data.name) || 'Server key');
    return created;
  }

  async function revokeApiKey(accountId: string, keyId: string) {
    const [row] = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .innerJoin(apps, eq(apps.id, apiKeys.appId))
      .where(and(eq(apiKeys.id, keyId), eq(apps.accountId, accountId), isNull(apiKeys.revokedAt)));
    if (!row) throw new PlatformError('not_found', 'No such key.', 404);
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, keyId));
  }

  async function setAppEmbedOrigins(accountId: string, appId: string, raw: unknown) {
    await appInAccount(accountId, appId);
    return studioApi.setEmbedOrigins(appId, raw);
  }

  async function authenticate(key: string | undefined): Promise<App> {
    if (!key) throw new PlatformError('unauthorised', 'Send your API key as a Bearer token.', 401);
    const [row] = await db
      .select({ app: apps, keyId: apiKeys.id })
      .from(apiKeys)
      .innerJoin(apps, eq(apps.id, apiKeys.appId))
      .where(and(eq(apiKeys.hash, sha256(key)), isNull(apiKeys.revokedAt)));
    if (!row) throw new PlatformError('unauthorised', 'That API key is not valid.', 401);
    void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.keyId)).catch(() => {});
    return row.app;
  }

  // ---------------------------------------------------------------- tenants

  async function upsertTenant(appId: string, externalId: string, raw: UpsertTenantInput) {
    const input = parse(UpsertTenantInput, raw);
    const values = {
      name: input.name,
      fromEmail: input.fromEmail ?? null,
      replyTo: input.replyTo ?? null,
      ...(input.sesTenant && { sesTenant: input.sesTenant }),
      // Left alone when not sent, so a host app's sync does not wipe what the business set in Appearance.
      ...(input.brand && { brand: input.brand as Brand }),
      ...(input.timezone && { timezone: input.timezone }),
    };
    const [row] = await db
      .insert(tenants)
      .values({ id: newId('ten'), appId, externalId, ...values })
      .onConflictDoUpdate({ target: [tenants.appId, tenants.externalId], set: values })
      .returning();
    // Every business gets its own SES tenant, so SES judges its reputation on its own.
    if (!row!.sesTenant) return { ...row!, sesTenant: await domainsApi.ensureSesTenant(row!) };
    return row!;
  }

  async function getTenant(appId: string, externalId: string): Promise<Tenant> {
    const [row] = await db
      .select()
      .from(tenants)
      .where(and(eq(tenants.appId, appId), eq(tenants.externalId, externalId)));
    if (!row) throw new PlatformError('tenant_not_found', `No tenant "${externalId}". Create it with PUT /v1/tenants/${externalId}.`, 404);
    return row;
  }

  // ---------------------------------------------------------------- suppression and consent

  /** Why this address must not receive this stream from this tenant, or null if it may. */
  async function blockedReason(tenantId: string, to: string, stream: 'transactional' | 'marketing') {
    const rows = await db
      .select({ reason: suppressions.reason, stream: suppressions.stream })
      .from(suppressions)
      .where(and(eq(suppressions.email, to), or(eq(suppressions.scope, 'global'), eq(suppressions.scope, tenantId))));
    const hit = rows.find((r) => r.stream === 'all' || stream === 'marketing');
    if (hit) return hit.reason;
    if (stream === 'marketing') {
      const [contact] = await db
        .select({ consent: contacts.marketingConsent })
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.email, to)));
      if (contact?.consent !== 'granted') return 'no_marketing_consent';
    }
    return null;
  }

  async function suppress(scope: string, address: string, reason: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual', stream: 'all' | 'marketing') {
    await db
      .insert(suppressions)
      .values({ id: newId('sup'), scope, email: address, reason, stream })
      .onConflictDoNothing();
  }

  /**
   * Records a consent change. Every record is kept, but the client's current answer only changes
   * when this one is the newest, so a late or replayed sync cannot overturn what they said since.
   */
  async function setConsent(tenantId: string, contactId: string, status: 'granted' | 'withdrawn', source: string, recordedAt = new Date()) {
    const [latest] = await db.select({ at: consents.recordedAt }).from(consents).where(eq(consents.contactId, contactId)).orderBy(desc(consents.recordedAt)).limit(1);
    await db.insert(consents).values({ id: newId('con'), tenantId, contactId, status, source, recordedAt });
    if (latest && latest.at > recordedAt) return false;
    await db.update(contacts).set({ marketingConsent: status, updatedAt: new Date() }).where(eq(contacts.id, contactId));
    return true;
  }

  // ---------------------------------------------------------------- contacts and app events

  /**
   * Removes a client at their request (UK GDPR right to erasure): the contact, their bookings,
   * consent history and events go; emails already sent stay in the counts but lose the address and
   * the words. An existing unsubscribe or bounce is kept, so they are never emailed again by
   * mistake if the app adds them back without asking.
   */
  async function eraseContact(app: App, raw: unknown) {
    const input = parse(
      z
        .object({ tenant: z.string().min(1), email: z.string().trim().toLowerCase().email().optional(), externalId: z.string().min(1).optional() })
        .refine((v) => v.email || v.externalId, 'Give the client’s email or externalId.'),
      raw,
    );
    const tenant = await getTenant(app.id, input.tenant);
    const [contact] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenant.id), input.email ? eq(contacts.email, input.email) : eq(contacts.externalId, input.externalId!)));
    if (!contact) return { erased: false };
    await db.transaction(async (tx) => {
      const sent = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.tenantId, tenant.id), eq(messages.to, contact.email)));
      const ids = sent.map((m) => m.id);
      if (ids.length) {
        // Anything still waiting to go is stopped. Each copy gets its own blank address, because a
        // campaign holds one copy per address.
        await tx
          .update(messages)
          .set({ status: 'failed', error: 'erased' })
          .where(and(inArray(messages.id, ids), inArray(messages.status, ['queued', 'sending'])));
        await tx
          .update(messages)
          .set({ to: sql`'erased+' || ${messages.id} || '@erased.invalid'`, subject: '(erased)', html: null, text: null, updatedAt: new Date() })
          .where(inArray(messages.id, ids));
        await tx.update(messageEvents).set({ detail: {} }).where(inArray(messageEvents.messageId, ids));
      }
      await tx.delete(flowSends).where(eq(flowSends.contactId, contact.id));
      await tx.delete(appointments).where(eq(appointments.contactId, contact.id));
      await tx.delete(appEvents).where(eq(appEvents.contactId, contact.id));
      await tx.delete(consents).where(eq(consents.contactId, contact.id));
      await tx.delete(contacts).where(eq(contacts.id, contact.id));
    });
    return { erased: true };
  }

  async function upsertContact(app: App, raw: UpsertContactInput) {
    const input = parse(UpsertContactInput, raw);
    const tenant = await getTenant(app.id, input.tenant);
    const set = {
      ...(input.externalId !== undefined && { externalId: input.externalId }),
      ...(input.firstName !== undefined && { firstName: input.firstName }),
      ...(input.lastName !== undefined && { lastName: input.lastName }),
      ...(input.attributes !== undefined && { attributes: input.attributes }),
      updatedAt: new Date(),
    };
    const [contact] = await db
      .insert(contacts)
      .values({ id: newId('ctc'), tenantId: tenant.id, email: input.email, ...set })
      .onConflictDoUpdate({ target: [contacts.tenantId, contacts.email], set })
      .returning();
    if (input.consent) {
      const recordedAt = input.consent.recordedAt ?? new Date();
      const current = await setConsent(tenant.id, contact!.id, input.consent.marketing, input.consent.source, recordedAt);
      if (current && input.consent.marketing === 'granted') {
        // An opt-in given after they unsubscribed lifts the unsubscribe; an older one does not.
        await db
          .delete(suppressions)
          .where(
            and(
              eq(suppressions.scope, tenant.id),
              eq(suppressions.email, input.email),
              eq(suppressions.reason, 'unsubscribe'),
              sql`${suppressions.createdAt} < ${recordedAt}`,
            ),
          );
      }
    }
    const [fresh] = await db.select().from(contacts).where(eq(contacts.id, contact!.id));
    return fresh!;
  }

  async function recordEvent(app: App, raw: RecordEventInput) {
    const input = parse(RecordEventInput, raw);
    const tenant = await getTenant(app.id, input.tenant);
    let contactId: string | null = null;
    if (input.email || input.contactExternalId) {
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenant.id),
            input.email ? eq(contacts.email, input.email) : eq(contacts.externalId, input.contactExternalId!),
          ),
        );
      contactId = contact?.id ?? null;
    }
    const [row] = await db
      .insert(appEvents)
      .values({
        id: newId('evt'),
        tenantId: tenant.id,
        contactId,
        name: input.name,
        properties: input.properties,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning();
    return row!;
  }

  // ---------------------------------------------------------------- sending

  function unsubscribeToken(messageId: string) {
    const mac = createHmac('sha256', config.signingSecret).update(`unsub:${messageId}`).digest('base64url').slice(0, 32);
    return `${messageId}.${mac}`;
  }

  function verifyUnsubscribeToken(token: string): string | null {
    const [messageId, mac] = token.split('.');
    if (!messageId || !mac) return null;
    const expected = unsubscribeToken(messageId).split('.')[1]!;
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b) ? messageId : null;
  }

  /**
   * Accepts an email for sending. It is stored and queued straight away; the queue sends it.
   * Suppressed addresses are stored with status "suppressed" and never sent, so callers can see why.
   */
  async function sendEmail(app: App, raw: SendEmailInput): Promise<Message> {
    const input = parse(SendEmailInput, raw);
    const tenant = await getTenant(app.id, input.tenant);
    if (tenant.status === 'paused') throw new PlatformError('tenant_paused', 'Sending is paused for this tenant.', 403);

    if (input.idempotencyKey) {
      const [existing] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.tenantId, tenant.id), eq(messages.idempotencyKey, input.idempotencyKey)));
      if (existing) return existing;
    }

    // Marketing counts against the business's plan; booking emails have a generous hourly ceiling.
    if (input.stream === 'marketing') {
      const problem = await billingApi.sendingProblem(tenant.id, 1);
      if (problem) throw new PlatformError('plan_limit', problem, 403);
    } else {
      await limitsApi.hit(`tx:${tenant.id}`, LIMITS.transactional);
    }
    if (input.from) await domainsApi.assertCanSendFrom(tenant, input.from);
    const sender = input.from ? { from: input.from, replyTo: tenant.replyTo } : await domainsApi.senderFor(tenant);
    const blocked = await blockedReason(tenant.id, input.to, input.stream);
    const id = newId('msg');
    const [message] = await db
      .insert(messages)
      .values({
        id,
        tenantId: tenant.id,
        stream: input.stream,
        idempotencyKey: input.idempotencyKey ?? null,
        to: input.to,
        from: sender.from,
        replyTo: input.replyTo ?? sender.replyTo,
        subject: input.subject,
        html: input.html ?? null,
        text: input.text ?? null,
        tags: input.tags,
        status: blocked ? 'suppressed' : 'queued',
        error: blocked,
      })
      .onConflictDoNothing()
      .returning();

    if (!message) {
      // Lost a race with the same idempotency key: return the winner.
      const [existing] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.tenantId, tenant.id), eq(messages.idempotencyKey, input.idempotencyKey!)));
      return existing!;
    }
    if (!blocked) await queue.enqueue('send-message', { messageId: id });
    return message;
  }

  /** Queue worker: hands one message to the transport. Safe to run twice for the same message. */
  async function processSend(messageId: string) {
    const [claimed] = await db
      .update(messages)
      .set({ status: 'sending', attempts: sql`${messages.attempts} + 1`, updatedAt: new Date() })
      .where(and(eq(messages.id, messageId), inArray(messages.status, ['queued', 'sending'])))
      .returning();
    if (!claimed) return; // already sent, or suppressed meanwhile
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, claimed.tenantId));
    if (tenant?.status === 'paused') {
      // Held, not lost: resuming the business queues these again.
      await db.update(messages).set({ status: 'queued', error: 'paused', updatedAt: new Date() }).where(eq(messages.id, claimed.id));
      return;
    }

    // Campaigns are paced over time, so someone may have unsubscribed since this was queued.
    if (claimed.stream === 'marketing') {
      const blocked = await blockedReason(claimed.tenantId, claimed.to, 'marketing');
      if (blocked) {
        await db.update(messages).set({ status: 'suppressed', error: blocked, updatedAt: new Date() }).where(eq(messages.id, claimed.id));
        return;
      }
    }

    const headers: Record<string, string> = { 'X-Platform-Message-Id': claimed.id };
    let unsubscribeUrl = '#';
    if (claimed.stream === 'marketing') {
      unsubscribeUrl = `${config.publicUrl}/u/${unsubscribeToken(claimed.id)}`;
      headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    const fillLink = (body: string | null, kind: 'html' | 'text') => {
      if (body === null) return null;
      // Every marketing email shows a way out (PECR reg. 22), even raw HTML sent through the API
      // without our footer: if the link is missing, a short line is added at the end.
      if (claimed.stream === 'marketing' && !body.includes('{{unsubscribe_url}}')) {
        body =
          kind === 'html'
            ? /<\/body>/i.test(body)
              ? body.replace(/<\/body>/i, `${UNSUBSCRIBE_HTML}</body>`)
              : body + UNSUBSCRIBE_HTML
            : `${body}\n\nUnsubscribe: {{unsubscribe_url}}`;
      }
      return body.replaceAll('{{unsubscribe_url}}', unsubscribeUrl);
    };

    try {
      const { providerMessageId } = await transport.send({
        messageId: claimed.id,
        from: claimed.from,
        to: claimed.to,
        replyTo: claimed.replyTo,
        subject: claimed.subject,
        html: fillLink(claimed.html, 'html'),
        text: fillLink(claimed.text, 'text'),
        headers,
        sesTenant: tenant?.sesTenant,
        tags: { ...claimed.tags, stream: claimed.stream },
      });
      await db
        .update(messages)
        .set({ status: 'sent', providerMessageId, sentAt: new Date(), updatedAt: new Date(), error: null })
        .where(and(eq(messages.id, claimed.id), eq(messages.status, 'sending')));
      await emit(claimed.tenantId, 'email.sent', claimed.id, {});
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof PermanentSendError) {
        await db.update(messages).set({ status: 'failed', error: reason, updatedAt: new Date() }).where(eq(messages.id, claimed.id));
        await emit(claimed.tenantId, 'email.failed', claimed.id, { reason });
        return;
      }
      await db.update(messages).set({ status: 'queued', error: reason, updatedAt: new Date() }).where(eq(messages.id, claimed.id));
      throw error; // let the queue retry with backoff
    }
  }

  // ---------------------------------------------------------------- SES events

  /** Applies one SES event (from SNS) to the message it belongs to. Unknown messages are ignored. */
  async function ingestSesEvent(body: unknown) {
    const event = parseSesEvent(body);
    if (!event) return { applied: false as const, reason: 'not an SES event' };
    const [message] = await db
      .select()
      .from(messages)
      .where(
        event.platformMessageId
          ? or(eq(messages.providerMessageId, event.providerMessageId), eq(messages.id, event.platformMessageId))
          : eq(messages.providerMessageId, event.providerMessageId),
      );
    if (!message) return { applied: false as const, reason: 'unknown message' };

    await db.insert(messageEvents).values({
      id: newId('mev'),
      messageId: message.id,
      type: event.type,
      occurredAt: event.occurredAt,
      detail: event.detail,
    });

    const next = SES_STATUS[event.type];
    if (next && RANK[next] > RANK[message.status]) {
      await db.update(messages).set({ status: next, updatedAt: new Date() }).where(eq(messages.id, message.id));
    }

    if (event.type === 'bounce' && event.permanent) {
      await suppress('global', message.to, 'hard_bounce', 'all');
    }
    if (event.type === 'complaint') {
      // Complaints stop marketing from this tenant; booking reminders and receipts still go.
      await suppress(message.tenantId, message.to, 'complaint', 'marketing');
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.tenantId, message.tenantId), eq(contacts.email, message.to)));
      if (contact) await setConsent(message.tenantId, contact.id, 'withdrawn', 'complaint');
    }

    const webhook = SES_WEBHOOK[event.type];
    if (webhook) await emit(message.tenantId, webhook, message.id, event.detail);
    if ((event.type === 'bounce' && event.permanent) || event.type === 'complaint') await guardReputation(message.tenantId);
    return { applied: true as const, messageId: message.id, type: event.type };
  }

  // ---------------------------------------------------------------- reputation

  /** Bounce and complaint rates over the last week, out of emails that actually left. */
  async function reputation(tenantId: string) {
    const since = new Date(Date.now() - REPUTATION_LIMITS.windowDays * 86_400_000);
    const [row] = await db
      .select({
        sent: sql<number>`(count(*) filter (where ${messages.status} in ('sent', 'delivered', 'delivery_delayed', 'bounced', 'complained')))::int`,
        bounced: sql<number>`(count(*) filter (where ${messages.status} = 'bounced'))::int`,
        complained: sql<number>`(count(*) filter (where ${messages.status} = 'complained'))::int`,
      })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), sql`${messages.sentAt} >= ${since}`));
    const { sent, bounced, complained } = row!;
    return { sent, bounced, complained, bounceRate: sent ? bounced / sent : 0, complaintRate: sent ? complained / sent : 0 };
  }

  /**
   * The circuit breaker. SES reviews a whole account at a 5% bounce or 0.1% complaint rate and can
   * pause it, which would stop every business. We pause the one business first, a little earlier.
   */
  async function guardReputation(tenantId: string) {
    const r = await reputation(tenantId);
    if (r.sent < REPUTATION_LIMITS.minimumSends) return;
    const reason =
      r.bounceRate > REPUTATION_LIMITS.bounceRate
        ? `${(r.bounceRate * 100).toFixed(1)}% of emails this week bounced. That usually means an old or bought list.`
        : r.complaintRate > REPUTATION_LIMITS.complaintRate
          ? `${(r.complaintRate * 100).toFixed(2)}% of people marked emails as spam this week.`
          : null;
    if (!reason) return;
    const [paused] = await db
      .update(tenants)
      .set({ status: 'paused', pausedReason: reason, pausedAt: new Date() })
      .where(and(eq(tenants.id, tenantId), eq(tenants.status, 'active')))
      .returning();
    if (paused) await emit(tenantId, 'tenant.paused', null, { reason, ...r });
  }

  /** Sending again after a pause: held emails go back on the queue, paced like a campaign. */
  async function resumeTenant(tenantId: string) {
    const [row] = await db
      .update(tenants)
      .set({ status: 'active', pausedReason: null, pausedAt: null })
      .where(eq(tenants.id, tenantId))
      .returning();
    if (!row) throw new PlatformError('not_found', 'No such business.', 404);
    const held = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.status, 'queued'), eq(messages.error, 'paused')));
    const start = Date.now();
    await queue.enqueueMany(
      'send-message',
      held.map((m, i) => ({ data: { messageId: m.id }, startAfter: new Date(start + (i / (config.sendRate ?? 10)) * 1000) })),
    );
    return row;
  }

  // ---------------------------------------------------------------- unsubscribe

  async function unsubscribe(token: string) {
    const messageId = verifyUnsubscribeToken(token);
    if (!messageId) throw new PlatformError('invalid_token', 'This unsubscribe link is not valid.', 404);
    const [message] = await db.select().from(messages).where(eq(messages.id, messageId));
    if (!message) throw new PlatformError('invalid_token', 'This unsubscribe link is not valid.', 404);
    await suppress(message.tenantId, message.to, 'unsubscribe', 'marketing');
    const [already] = await db
      .select({ id: messageEvents.id })
      .from(messageEvents)
      .where(and(eq(messageEvents.messageId, message.id), eq(messageEvents.type, 'unsubscribe')));
    if (!already) await db.insert(messageEvents).values({ id: newId('mev'), messageId: message.id, type: 'unsubscribe', occurredAt: new Date() });
    const [contact] = await db
      .select({ id: contacts.id, consent: contacts.marketingConsent })
      .from(contacts)
      .where(and(eq(contacts.tenantId, message.tenantId), eq(contacts.email, message.to)));
    if (contact && contact.consent !== 'withdrawn') await setConsent(message.tenantId, contact.id, 'withdrawn', 'unsubscribe-link');
    await emit(message.tenantId, 'contact.unsubscribed', message.id, {});
    const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, message.tenantId));
    return { email: message.to, tenantName: tenant?.name ?? '' };
  }

  // ---------------------------------------------------------------- outbound webhooks

  async function addWebhookEndpoint(appId: string, url: string, eventTypes: WebhookEvent[] = []) {
    const parsed = parse(z.url({ protocol: /^https$/ }), url);
    await assertPublicUrl(parsed, resolve);
    const secret = `whsec_${randomBytes(24).toString('base64')}`;
    const id = newId('whe');
    await db.insert(webhookEndpoints).values({ id, appId, url: parsed, secret, eventTypes });
    return { id, secret };
  }

  async function listWebhookEndpoints(appId: string) {
    const rows = await db
      .select({ id: webhookEndpoints.id, url: webhookEndpoints.url, events: webhookEndpoints.eventTypes, createdAt: webhookEndpoints.createdAt })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.appId, appId), isNull(webhookEndpoints.disabledAt)))
      .orderBy(webhookEndpoints.createdAt);
    return rows;
  }

  /** Stops an endpoint receiving events. To change a leaked secret, add a new endpoint and remove the old one. */
  async function removeWebhookEndpoint(appId: string, id: string) {
    const [row] = await db
      .update(webhookEndpoints)
      .set({ disabledAt: new Date() })
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.appId, appId), isNull(webhookEndpoints.disabledAt)))
      .returning({ id: webhookEndpoints.id });
    if (!row) throw new PlatformError('not_found', 'No such webhook.', 404);
  }

  /** Records an event for every endpoint of the tenant's app that wants it, and queues delivery. */
  async function emit(tenantId: string, type: WebhookEvent, messageId: string | null, detail: Record<string, unknown>) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) return;
    const endpoints = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.appId, tenant.appId), isNull(webhookEndpoints.disabledAt)));
    const wanted = endpoints.filter((e) => e.eventTypes.length === 0 || e.eventTypes.includes(type));
    if (!wanted.length) return;
    let message: Message | undefined;
    if (messageId) [message] = await db.select().from(messages).where(eq(messages.id, messageId));
    const payload = {
      type,
      createdAt: new Date().toISOString(),
      data: {
        tenant: tenant.externalId,
        ...(message && {
          emailId: message.id,
          to: message.to,
          subject: message.subject,
          stream: message.stream,
          tags: message.tags,
        }),
        ...detail,
      },
    };
    for (const endpoint of wanted) {
      const id = newId('whd');
      await db.insert(webhookDeliveries).values({ id, endpointId: endpoint.id, eventType: type, payload });
      await queue.enqueue('deliver-webhook', { deliveryId: id });
    }
  }

  /** Queue worker: posts one signed webhook (Standard Webhooks format). Throws to retry. */
  async function processWebhook(deliveryId: string) {
    const [row] = await db
      .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(eq(webhookDeliveries.id, deliveryId));
    if (!row || row.delivery.status === 'delivered') return;
    const body = JSON.stringify(row.delivery.payload);
    const timestamp = new Date();
    const signature = new Webhook(row.endpoint.secret).sign(deliveryId, timestamp, body);
    let failure: string | null = null;
    try {
      // Checked again on every delivery: the address a name points to can change after it was added.
      await assertPublicUrl(row.endpoint.url, resolve);
      const response = await doFetch(row.endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': deliveryId,
          'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
          'webhook-signature': signature,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 300 && response.status < 400) failure = `HTTP ${response.status}: redirects are not followed`;
      else if (!response.ok) failure = `HTTP ${response.status}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await db
      .update(webhookDeliveries)
      .set({
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        status: failure ? 'failed' : 'delivered',
        lastError: failure,
        deliveredAt: failure ? null : new Date(),
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    if (failure) throw new Error(`Webhook ${deliveryId} failed: ${failure}`);
  }

  // ---------------------------------------------------------------- reads for the app

  async function listMessages(tenantId: string, options: { limit?: number; statuses?: readonly MessageStatus[] } = {}) {
    const where = options.statuses?.length
      ? and(eq(messages.tenantId, tenantId), inArray(messages.status, [...options.statuses]))
      : eq(messages.tenantId, tenantId);
    return db.select().from(messages).where(where).orderBy(desc(messages.createdAt)).limit(options.limit ?? 50);
  }

  async function messageStats(tenantId: string, since: Date) {
    const rows = await db
      .select({ status: messages.status, count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), sql`${messages.createdAt} >= ${since}`))
      .groupBy(messages.status);
    return Object.fromEntries(rows.map((r) => [r.status, r.count])) as Partial<Record<MessageStatus, number>>;
  }

  /** Emails created per day since `since`, with how many reached the inbox, oldest first, one row per day. */
  async function dailyCounts(tenantId: string, since: Date) {
    const rows = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${messages.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        total: sql<number>`count(*)::int`,
        delivered: sql<number>`(count(*) filter (where ${messages.status} = 'delivered'))::int`,
      })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), sql`${messages.createdAt} >= ${since}`))
      .groupBy(sql`1`);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const days: { day: string; total: number; delivered: number }[] = [];
    const start = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
    for (let d = start; d.getTime() <= Date.now(); d = new Date(d.getTime() + 86_400_000)) {
      const day = d.toISOString().slice(0, 10);
      days.push({ day, total: byDay.get(day)?.total ?? 0, delivered: byDay.get(day)?.delivered ?? 0 });
    }
    return days;
  }

  /** Runs one queued job. Wire this to the queue's worker. */
  async function runJob<N extends JobName>(name: N, data: Jobs[N]) {
    if (name === 'send-message') return processSend((data as Jobs['send-message']).messageId);
    if (name === 'deliver-webhook') return processWebhook((data as Jobs['deliver-webhook']).deliveryId);
    if (name === 'send-campaign') return campaignsApi.processCampaign((data as Jobs['send-campaign']).campaignId);
    if (name === 'check-domain') return void (await domainsApi.checkDomain((data as Jobs['check-domain']).domainId, { reschedule: true }));
    if (name === 'run-flows') {
      const { tenantId } = data as Jobs['run-flows'];
      if (tenantId) return void (await flowsApi.runFlows(tenantId));
      // The hourly tick: one job per business with a flow switched on.
      const due = await db
        .selectDistinct({ tenantId: flows.tenantId })
        .from(flows)
        .innerJoin(tenants, eq(tenants.id, flows.tenantId))
        .where(and(eq(flows.live, true), eq(tenants.status, 'active')));
      await queue.enqueueMany('run-flows', due.map((d) => ({ data: { tenantId: d.tenantId } })));
    }
  }

  return {
    ...createAudience(db),
    ...campaignsApi,
    ...domainsApi,
    ...diary,
    ...flowsApi,
    reputation,
    resumeTenant,
    ...studioApi,
    createAccountWithApp,
    createApp,
    createApiKey,
    listApps,
    addApp,
    addApiKey,
    revokeApiKey,
    setAppEmbedOrigins,
    authenticate,
    upsertTenant,
    getTenant,
    upsertContact,
    eraseContact,
    recordEvent,
    sendEmail,
    processSend,
    ingestSesEvent,
    unsubscribe,
    unsubscribeToken,
    hitLimit: limitsApi.hit,
    addWebhookEndpoint,
    listWebhookEndpoints,
    removeWebhookEndpoint,
    processWebhook,
    listMessages,
    messageStats,
    dailyCounts,
    ...insights,
    ...assetsApi,
    ...billingApi,
    ...onboardingApi,
    runJob,
  };
}

export type Engine = ReturnType<typeof createEngine>;
