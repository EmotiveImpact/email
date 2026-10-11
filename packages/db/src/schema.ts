/**
 * The platform's data model.
 *
 * account  → whoever pays (you, an agency, a third-party SaaS). Also the sign-in "organisation":
 *            Better Auth's organisation model is stored in this table, so members belong to an account.
 * app      → a product sending through the platform (Saleane, Caleane)
 * tenant   → one sending business inside an app (a single salon); maps 1:1 to an SES tenant
 *
 * Everything a studio owns (contacts, messages, events) hangs off a tenant.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  /** Better Auth stores organisation metadata as a JSON string. */
  metadata: text('metadata'),
  createdAt: created(),
});

// ---------------------------------------------------------------- sign-in (Better Auth)
// JS keys match Better Auth's field names; columns are snake_case like the rest.

const updated = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: created(),
  updatedAt: updated(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    activeOrganizationId: text('active_account_id'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

/** Sign-in methods per user (password, Google, ...). Better Auth calls these "accounts". */
export const logins = pgTable(
  'logins',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('provider_account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('logins_user').on(t.userId)],
);

export const verifications = pgTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('verifications_identifier').on(t.identifier)],
);

/** People in an account, with their role ("owner", "admin", "member"). */
export const members = pgTable(
  'members',
  {
    id: text('id').primaryKey(),
    organizationId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('members_account_user').on(t.organizationId, t.userId), index('members_user').on(t.userId)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    organizationId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    inviterId: text('inviter_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [index('invitations_account').on(t.organizationId), index('invitations_email').on(t.email)],
);

export const apps = pgTable('apps', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  name: text('name').notNull(),
  /** Web origins allowed to embed the studio (for example https://app.saleane.com). */
  embedOrigins: jsonb('embed_origins').$type<string[]>().notNull().default([]),
  createdAt: created(),
});

/** How a tenant's screens look. Every field is optional; the platform default fills the gaps. */
export type Brand = {
  accent?: string;
  rail?: 'light' | 'pigment';
  headingFont?: 'cal-sans' | 'geist' | 'serif';
  logoUrl?: string;
  /** Postal address for the footer of marketing email. */
  address?: string;
};

export const tenants = pgTable(
  'tenants',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull().references(() => apps.id),
    /** The app's own id for this business, e.g. Saleane's studio id. */
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    fromEmail: text('from_email'),
    replyTo: text('reply_to'),
    /** Name of the matching SES tenant, once created. */
    sesTenant: text('ses_tenant'),
    status: text('status', { enum: ['active', 'paused'] }).notNull().default('active'),
    /** Why sending was paused, in words the business can act on. */
    pausedReason: text('paused_reason'),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    brand: jsonb('brand').$type<Brand>().notNull().default({}),
    createdAt: created(),
  },
  (t) => [uniqueIndex('tenants_app_external').on(t.appId, t.externalId)],
);

export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => apps.id),
  name: text('name').notNull(),
  /** First characters of the key, shown in the UI so people can tell keys apart. */
  prefix: text('prefix').notNull(),
  /** SHA-256 of the full key. The key itself is never stored. */
  hash: text('hash').notNull().unique(),
  createdAt: created(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const contacts = pgTable(
  'contacts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    externalId: text('external_id'),
    email: text('email').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    /** Latest marketing consent; the full history lives in `consents`. */
    marketingConsent: text('marketing_consent', { enum: ['granted', 'withdrawn', 'unknown'] })
      .notNull()
      .default('unknown'),
    createdAt: created(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('contacts_tenant_email').on(t.tenantId, t.email),
    index('contacts_tenant_external').on(t.tenantId, t.externalId),
  ],
);

/** Append-only consent history, so we can always show when and how someone agreed. */
export const consents = pgTable(
  'consents',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    contactId: text('contact_id').notNull().references(() => contacts.id),
    status: text('status', { enum: ['granted', 'withdrawn'] }).notNull(),
    /** Where it came from, e.g. "saleane:booking-form" or "unsubscribe-link". */
    source: text('source').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    createdAt: created(),
  },
  (t) => [index('consents_contact').on(t.contactId)],
);

/**
 * Addresses we must not send to. `scope` is a tenant id, or 'global' for hard bounces and
 * complaints that protect every tenant.
 */
export const suppressions = pgTable(
  'suppressions',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    email: text('email').notNull(),
    reason: text('reason', { enum: ['hard_bounce', 'complaint', 'unsubscribe', 'manual'] }).notNull(),
    /** Only 'marketing' suppressions let transactional mail through. */
    stream: text('stream', { enum: ['all', 'marketing'] }).notNull().default('all'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('suppressions_scope_email_reason').on(t.scope, t.email, t.reason)],
);

export const MESSAGE_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'delivery_delayed',
  'bounced',
  'complained',
  'rejected',
  'failed',
  'suppressed',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    stream: text('stream', { enum: ['transactional', 'marketing'] }).notNull(),
    idempotencyKey: text('idempotency_key'),
    to: text('to_email').notNull(),
    from: text('from_email').notNull(),
    replyTo: text('reply_to'),
    subject: text('subject').notNull(),
    html: text('html'),
    text: text('text'),
    tags: jsonb('tags').$type<Record<string, string>>().notNull().default({}),
    status: text('status', { enum: MESSAGE_STATUSES }).notNull().default('queued'),
    providerMessageId: text('provider_message_id'),
    /** Set when the email was one recipient's copy of a campaign. */
    campaignId: text('campaign_id'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: created(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('messages_tenant_idempotency')
      .on(t.tenantId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    uniqueIndex('messages_provider_id').on(t.providerMessageId),
    // One copy per person per campaign, even if the expansion job runs twice.
    uniqueIndex('messages_campaign_recipient').on(t.campaignId, t.to).where(sql`${t.campaignId} is not null`),
    index('messages_tenant_created').on(t.tenantId, t.createdAt),
  ],
);

export const messageEvents = pgTable(
  'message_events',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull().references(() => messages.id),
    type: text('type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: created(),
  },
  (t) => [index('message_events_message').on(t.messageId)],
);

/** Things that happened in the app ("booking.created"), which automations react to. */
export const appEvents = pgTable(
  'app_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    contactId: text('contact_id').references(() => contacts.id),
    name: text('name').notNull(),
    properties: jsonb('properties').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: created(),
  },
  (t) => [
    index('app_events_tenant_name').on(t.tenantId, t.name, t.occurredAt),
    index('app_events_contact').on(t.contactId, t.name, t.occurredAt),
  ],
);

export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull().references(() => apps.id),
  url: text('url').notNull(),
  /** Standard Webhooks secret ("whsec_" + base64). */
  secret: text('secret').notNull(),
  /** Empty means every event type. */
  eventTypes: jsonb('event_types').$type<string[]>().notNull().default([]),
  createdAt: created(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    endpointId: text('endpoint_id').notNull().references(() => webhookEndpoints.id),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['pending', 'delivered', 'failed'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: created(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [index('webhook_deliveries_endpoint').on(t.endpointId, t.createdAt)],
);

/**
 * A saved group of contacts, defined by rules (see `SegmentDefinition` in the engine) and
 * worked out when it is used, so it is always up to date.
 */
export const segments = pgTable(
  'segments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    name: text('name').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    createdAt: created(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('segments_tenant').on(t.tenantId)],
);

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** A one-off email to a segment (or everyone who said yes to news). */
export const campaigns = pgTable(
  'campaigns',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    name: text('name').notNull(),
    subject: text('subject').notNull().default(''),
    /** The editor document (`EmailDoc` in @platform/content). */
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    /** Null means everyone who said yes to news. */
    segmentId: text('segment_id').references(() => segments.id, { onDelete: 'set null' }),
    status: text('status', { enum: CAMPAIGN_STATUSES }).notNull().default('draft'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** Counted when the campaign goes out: who got it and who was left out, and why. */
    recipients: integer('recipients'),
    skippedNoConsent: integer('skipped_no_consent'),
    skippedSuppressed: integer('skipped_suppressed'),
    createdBy: text('created_by'),
    createdAt: created(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('campaigns_tenant').on(t.tenantId, t.createdAt)],
);

/** How the studio looks inside a host app. The host's own colours and type, so it feels native. */
export type StudioTheme = {
  accent?: string;
  headingFont?: 'cal-sans' | 'geist' | 'serif';
  /** Page background behind the cards, such as Saleane's ivory. */
  canvas?: string;
};

/**
 * A host app opening the studio for one of its users. The app asks for a launch token (short-lived,
 * single use) from its server; the studio swaps it for a session token held only in the browser tab.
 * Only hashes of either token are stored.
 */
export const studioSessions = pgTable(
  'studio_sessions',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The person in the host app: its own id for them, plus name and email for display and test sends. */
    userRef: text('user_ref').notNull(),
    userName: text('user_name'),
    userEmail: text('user_email'),
    origin: text('origin').notNull(),
    theme: jsonb('theme').$type<StudioTheme>().notNull().default({}),
    launchHash: text('launch_hash').notNull().unique(),
    launchExpiresAt: timestamp('launch_expires_at', { withTimezone: true }).notNull(),
    sessionHash: text('session_hash').unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: created(),
  },
);

export const DOMAIN_STATUSES = ['pending', 'verified', 'failed'] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];
export type DnsRecord = { type: 'CNAME' | 'TXT' | 'MX'; name: string; value: string };

/**
 * A domain a business sends from. SES signs its mail with DKIM once the CNAME records are in the
 * domain's DNS. A domain belongs to one business, since SES identities are account-wide.
 */
export const domains = pgTable('domains', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id),
  domain: text('domain').notNull().unique(),
  status: text('status', { enum: DOMAIN_STATUSES }).notNull().default('pending'),
  /** The DKIM records to add, as SES gave them. */
  records: jsonb('records').$type<DnsRecord[]>().notNull().default([]),
  /** Whether a DMARC record was found at the last check (Gmail and Yahoo expect one for bulk mail). */
  dmarc: boolean('dmarc').notNull().default(false),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: created(),
});
