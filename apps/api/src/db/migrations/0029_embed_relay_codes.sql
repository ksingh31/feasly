-- EMB-06: single-use relay codes for magic-link token relay inside the iframe.
--
-- The magic-link email for an embed lead points at the BUILDER's page
-- (tenant `report_url_template`, e.g. https://elitebuilder.com/estimate?feasly_rt={code}).
-- {code} is a 10-minute-expiry, 32-byte random token. Only the SHA-256 hash
-- is stored — the plaintext exists only in the email URL.
--
-- `POST /api/v1/embed/session {code, tenant_key}` validates hash/expiry/
-- single-use + tenant match atomically (UPDATE ... WHERE used_at IS NULL)
-- and returns a 12h in-memory session token. Replays and expired codes get
-- 410 with a re-issue affordance.
--
-- The audit log records every exchange attempt (success AND failure) with
-- tenant_key, code_id, ip_hash and result. No raw IPs, no plaintext codes,
-- no PII — enforced by code review, not the schema.
CREATE TABLE "embed_relay_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"tenant_key" text NOT NULL,
	"user_id" uuid,
	"estimate_id" uuid,
	"lead_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embed_relay_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE INDEX "embed_relay_codes_expires_at_idx" ON "embed_relay_codes" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE "embed_relay_audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_id" uuid,
	"tenant_key" text NOT NULL,
	"ip_hash" text NOT NULL,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "embed_relay_audit_log_code_id_idx" ON "embed_relay_audit_log" USING btree ("code_id");
--> statement-breakpoint
CREATE INDEX "embed_relay_audit_log_tenant_key_idx" ON "embed_relay_audit_log" USING btree ("tenant_key");
