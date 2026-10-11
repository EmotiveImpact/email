CREATE TABLE "studio_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_ref" text NOT NULL,
	"user_name" text,
	"user_email" text,
	"origin" text NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"launch_hash" text NOT NULL,
	"launch_expires_at" timestamp with time zone NOT NULL,
	"session_hash" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_sessions_launch_hash_unique" UNIQUE("launch_hash"),
	CONSTRAINT "studio_sessions_session_hash_unique" UNIQUE("session_hash")
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "embed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_sessions" ADD CONSTRAINT "studio_sessions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_sessions" ADD CONSTRAINT "studio_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;