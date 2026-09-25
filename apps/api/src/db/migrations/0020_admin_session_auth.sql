CREATE TABLE "admin_allowlist" (
	"email" text PRIMARY KEY NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_email" text,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"session_token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_sessions_session_token_hash_unique" UNIQUE("session_token_hash")
);
--> statement-breakpoint
CREATE INDEX "admin_audit_log_action_idx" ON "admin_audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "admin_sessions_token_hash_idx" ON "admin_sessions" USING btree ("session_token_hash");--> statement-breakpoint
CREATE INDEX "admin_sessions_email_idx" ON "admin_sessions" USING btree ("email");--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN "email" text;--> statement-breakpoint
-- admin/01: seed the admin allowlist with Karan's email (the only admin
-- until Karan names others). Idempotent for re-runs.
INSERT INTO "admin_allowlist" ("email", "added_by") VALUES ('karanbirsingh667@gmail.com', 'seed') ON CONFLICT ("email") DO NOTHING;