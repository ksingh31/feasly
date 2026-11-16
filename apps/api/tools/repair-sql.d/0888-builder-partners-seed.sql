-- #888: builder partner seed guard. Mirrors migration 0055 exactly (same
-- fixed UUID): Elite Craft Builders is the current partner. A no-op when
-- the row already exists — an admin's later edits (deactivate, reorder,
-- rename) are never overwritten.
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
