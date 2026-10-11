CREATE TABLE "subscriptions" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"customer_id" text,
	"subscription_id" text,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "direct" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "problem" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_id" ON "subscriptions" USING btree ("subscription_id") WHERE "subscriptions"."subscription_id" is not null;--> statement-breakpoint
CREATE INDEX "subscriptions_customer" ON "subscriptions" USING btree ("customer_id");
--> statement-breakpoint
UPDATE "apps" SET "direct" = true WHERE "name" = 'Direct';