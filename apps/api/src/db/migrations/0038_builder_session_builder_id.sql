-- Server-side tenant for builder sessions (auth/04).
--
-- builder_sessions gains a nullable builder_id FK: the session's builder
-- tenant resolved server-side at sign-in. Tenant scoping for builder
-- sessions reads this column, never the legacy tenant_key text and never a
-- request value. Backfilled from builders.tenant_key for existing rows;
-- stays NULL only when the row's tenant_key has no builder row.
--> statement-breakpoint
ALTER TABLE "builder_sessions" ADD COLUMN "builder_id" uuid REFERENCES "builders"("id") ON DELETE CASCADE;
--> statement-breakpoint
UPDATE "builder_sessions" AS bs
SET "builder_id" = b."id"
FROM "builders" AS b
WHERE bs."builder_id" IS NULL AND b."tenant_key" = bs."tenant_key";
--> statement-breakpoint
CREATE INDEX "builder_sessions_builder_id_idx" ON "builder_sessions" ("builder_id");
