CREATE TABLE "diary_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_id" text NOT NULL,
	"location_id" text,
	"location_name" text,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"service_id" text,
	"consent" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"error" text,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diary_connections" ADD CONSTRAINT "diary_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "diary_connections_tenant_provider" ON "diary_connections" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE INDEX "diary_connections_account" ON "diary_connections" USING btree ("provider","account_id");