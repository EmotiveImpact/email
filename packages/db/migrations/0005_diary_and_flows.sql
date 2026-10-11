CREATE TABLE "appointments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"external_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"service" text,
	"staff" text,
	"price" integer,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"booked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"reason" text NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"live" boolean DEFAULT false NOT NULL,
	"subject" text NOT NULL,
	"content" jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_slots" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"staff" text,
	"service" text
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "flow_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "timezone" text DEFAULT 'Europe/London' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_sends" ADD CONSTRAINT "flow_sends_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_sends" ADD CONSTRAINT "flow_sends_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_sends" ADD CONSTRAINT "flow_sends_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_slots" ADD CONSTRAINT "open_slots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_tenant_external" ON "appointments" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "appointments_contact" ON "appointments" USING btree ("contact_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_tenant_starts" ON "appointments" USING btree ("tenant_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_tenant_booked" ON "appointments" USING btree ("tenant_id","booked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_sends_once" ON "flow_sends" USING btree ("flow_id","contact_id","reason");--> statement-breakpoint
CREATE INDEX "flow_sends_contact" ON "flow_sends" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flows_tenant_kind" ON "flows" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "open_slots_tenant_starts" ON "open_slots" USING btree ("tenant_id","starts_at");--> statement-breakpoint
CREATE INDEX "messages_flow" ON "messages" USING btree ("flow_id") WHERE "messages"."flow_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_tenant_to" ON "messages" USING btree ("tenant_id","to_email","sent_at");