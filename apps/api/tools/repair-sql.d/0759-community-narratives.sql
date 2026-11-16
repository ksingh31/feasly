-- #759: monthly community narratives. Mirrors migration 0060; idempotent and
-- dependent only on the core (no other fragment).
CREATE TABLE IF NOT EXISTS "community_narratives" (
	"community_slug" text NOT NULL,
	"period" text NOT NULL,
	"narrative" text,
	"model" text,
	"prompt_version" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"generated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_narratives_slug_period_pk" PRIMARY KEY("community_slug","period")
);
ALTER TABLE "community_narratives" ADD COLUMN IF NOT EXISTS "narrative" text;
ALTER TABLE "community_narratives" ADD COLUMN IF NOT EXISTS "model" text;
ALTER TABLE "community_narratives" ADD COLUMN IF NOT EXISTS "prompt_version" text DEFAULT 'unknown' NOT NULL;
ALTER TABLE "community_narratives" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'failed' NOT NULL;
ALTER TABLE "community_narratives" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "community_narratives" ADD COLUMN IF NOT EXISTS "last_error" text;
ALTER TABLE "community_narratives" ADD COLUMN IF NOT EXISTS "generated_at" timestamp with time zone;
ALTER TABLE "community_narratives" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
CREATE INDEX IF NOT EXISTS "community_narratives_status_idx" ON "community_narratives" USING btree ("status");
