/**
 * The platform's data model.
 *
 * account  → whoever pays (you, an agency, a third-party SaaS)
 * app      → a product sending through the platform (Saleane, Caleane)
 * tenant   → one sending business inside an app (a single salon); maps 1:1 to an SES tenant
 *
 * Everything a studio owns (contacts, messages, events) hangs off a tenant.
 */
import { sql } from 'drizzle-orm';
import {
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
  createdAt: created(),
});

export const apps = pgTable('apps', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  name: text('name').notNull(),
  createdAt: created(),
});

/** How a tenant's screens look. Every field is optional; the platform default fills the gaps. */
export type Brand = {
  accent?: string;
  rail?: 'light' | 'pigment';
  headingFont?: 'cal-sans' | 'geist' | 'serif';
  logoUrl?: string;
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
  (t) => [index('app_events_tenant_name').on(t.tenantId, t.name, t.occurredAt)],
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
