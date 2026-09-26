CREATE TABLE "builder_allowlist" (
	"email" text PRIMARY KEY NOT NULL,
	"tenant_key" text NOT NULL REFERENCES "tenants"("tenant_key") ON DELETE CASCADE,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builder_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"tenant_key" text NOT NULL REFERENCES "tenants"("tenant_key") ON DELETE CASCADE,
	"session_token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builder_sessions_session_token_hash_unique" UNIQUE("session_token_hash")
);
--> statement-breakpoint
CREATE INDEX "builder_sessions_token_hash_idx" ON "builder_sessions" USING btree ("session_token_hash");--> statement-breakpoint
CREATE INDEX "builder_sessions_email_idx" ON "builder_sessions" USING btree ("email");--> statement-breakpoint
CREATE INDEX "builder_sessions_tenant_key_idx" ON "builder_sessions" USING btree ("tenant_key");--> statement-breakpoint
CREATE INDEX "builder_allowlist_tenant_key_idx" ON "builder_allowlist" USING btree ("tenant_key");
