CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "app_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"contact_id" text,
	"name" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"external_id" text,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"marketing_consent" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_events" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"stream" text NOT NULL,
	"idempotency_key" text,
	"to_email" text NOT NULL,
	"from_email" text NOT NULL,
	"reply_to" text,
	"subject" text NOT NULL,
	"html" text,
	"text" text,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"stream" text DEFAULT 'all' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"from_email" text,
	"reply_to" text,
	"ses_tenant" text,
	"status" text DEFAULT 'active' NOT NULL,
	"brand" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_events" ADD CONSTRAINT "app_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_events" ADD CONSTRAINT "app_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_events_tenant_name" ON "app_events" USING btree ("tenant_id","name","occurred_at");--> statement-breakpoint
CREATE INDEX "consents_contact" ON "consents" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_tenant_email" ON "contacts" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "contacts_tenant_external" ON "contacts" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "message_events_message" ON "message_events" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_tenant_idempotency" ON "messages" USING btree ("tenant_id","idempotency_key") WHERE "messages"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_id" ON "messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_tenant_created" ON "messages" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_scope_email_reason" ON "suppressions" USING btree ("scope","email","reason");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_app_external" ON "tenants" USING btree ("app_id","external_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint" ON "webhook_deliveries" USING btree ("endpoint_id","created_at");