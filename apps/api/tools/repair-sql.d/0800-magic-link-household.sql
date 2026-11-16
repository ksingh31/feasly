-- #800: household magic links. Mirrors migration 0057.
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "household" boolean DEFAULT false NOT NULL;
