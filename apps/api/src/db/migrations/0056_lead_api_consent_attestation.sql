-- Agent-API lead consent attestation (#738, owner decision 2026-11-15).
--
-- A lead submitted with an API key (REST POST /api/v1/leads with a Bearer
-- key, or the MCP submit_lead tool) must carry consent: true plus the
-- current consentVersion. These columns record who attested and when:
-- `consent_version` (the attested wording tag), `consent_attested_by_api_key_id`
-- (the api_keys row that attested — no FK so revoked/deleted keys keep the
-- audit trail) and `consent_attested_at`.
-- Expand step only: all nullable, no default, no backfill — web/embed leads
-- keep NULL (their consent is the gate checkbox, recorded in consent_ts).
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "consent_version" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "consent_attested_by_api_key_id" uuid;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "consent_attested_at" timestamp with time zone;
