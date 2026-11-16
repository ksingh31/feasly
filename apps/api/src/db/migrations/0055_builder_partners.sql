-- Builder partners (#888, partner disclosure from #847).
--
-- The builder companies that receive leads from Feasly's own site, listed
-- publicly by GET /api/v1/partners (active rows, display_order). Expand
-- only: a new table plus one seed row — no change to existing data.
CREATE TABLE IF NOT EXISTS "builder_partners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"builder_id" uuid REFERENCES "builders"("id") ON DELETE SET NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"website_url" text,
	"description" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_partners_active_order_idx" ON "builder_partners" USING btree ("active","display_order");
--> statement-breakpoint
-- Seed: Elite Craft Builders is the current partner (every direct lead goes
-- to them today). Fixed UUID keeps the seed deterministic; linked to the
-- builders row when it exists.
INSERT INTO "builder_partners"
  ("id", "builder_id", "name", "website_url", "display_order", "active")
SELECT
  '3fc7bb9f-e00b-4028-9255-e01730fd17c9',
  (SELECT b."id" FROM "builders" b WHERE b."tenant_key" = 'elite-craft-builders'),
  'Elite Craft Builders',
  'https://elitecraftbuilders.com',
  0,
  true
ON CONFLICT ("id") DO NOTHING;
