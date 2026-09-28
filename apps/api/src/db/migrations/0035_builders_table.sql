-- Builders table (embed/02 admin-UI migration): builders move off the
-- hardcoded repo-JSON configs (`config/builders/*.json`) into Postgres.
-- The DB is now the runtime source of truth for builder config; the JSON
-- files remain as the seed source (this migration) and the offline fallback.
--
-- `tenant_key` stays the join key the billing/attribution code uses
-- (attribution_events, commission_invoices, builder_sessions all key on it).
-- `plan` carries the billing model (null = undecided). `status` gates
-- active billing. `settings` is the escape hatch for future per-builder
-- config without new migrations.
--
-- `leads.builder_id` is the admin assignment link: nullable, null by
-- default, so the current lead flow is untouched. The builder portal scopes
-- its lead list to builder_id (backfilled from tenant_key below, so
-- existing embed leads keep showing for their builder).
--> statement-breakpoint
CREATE TABLE "builders" (
  "id" uuid PRIMARY KEY,
  "tenant_key" text NOT NULL UNIQUE,
  "business_name" text NOT NULL,
  "display_name" text NOT NULL,
  "email" text,
  "phone" text,
  "logo_url" text,
  "accent_color" text,
  "allowed_origins" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "plan" text,
  "status" text NOT NULL DEFAULT 'active',
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Seed from the repo JSON configs (config/builders/*.json as of 2026-09-27).
-- Fixed UUIDs keep the seed deterministic across environments.
INSERT INTO "builders"
  ("id", "tenant_key", "business_name", "display_name", "email", "phone",
   "logo_url", "accent_color", "allowed_origins", "plan", "status")
VALUES
  ('a506cc36-ffd1-42db-993c-999bfbb0f1d2', 'elite-craft-builders',
   'Elite Craft Builders', 'Elite Craft Builders', '', '',
   '', '#B08D57', '["https://elitecraftbuilders.com"]'::jsonb, NULL, 'active'),
  ('6f2c90fd-2395-4f6c-8e71-3b699cf68857', 'demo',
   'Demo Builder', 'Demo Builder', 'demo@example.com', '(555) 010-2030',
   '', '#0F766E', '["https://demo.example.com"]'::jsonb, NULL, 'active')
ON CONFLICT ("tenant_key") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "builder_id" uuid REFERENCES "builders"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_builder_id_idx" ON "leads" ("builder_id");
--> statement-breakpoint
-- Backfill: leads captured via a builder's embed keep showing in that
-- builder's portal (tenant_key -> builders.tenant_key join). Leads with no
-- tenant_key (or an unknown one) stay NULL — untouched flow.
UPDATE "leads" l
SET "builder_id" = b."id"
FROM "builders" b
WHERE l."tenant_key" = b."tenant_key"
  AND l."builder_id" IS NULL;
