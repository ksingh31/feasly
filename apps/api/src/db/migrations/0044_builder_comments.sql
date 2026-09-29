-- Lead comments (BILL-05, 2026-09-29).
--
-- `builder_comments`: one table for every commentable entity.
-- `entity_type`/`entity_id` are generic from day one ('lead' for now;
-- 'invoice' later for the dispute thread) so no migration is needed then.
--
-- Visibility model (enforced in SQL by the store, never in JS):
-- - 'org': visible to the entity's builder org and to admins.
-- - 'admin_only': visible to admins only. The builder read path adds
--   `visibility = 'org'` to the WHERE clause.
--
-- Edit, not delete (Karan 2026-09-29): authors edit their own comments
-- (`updated_at` bump); admins soft-delete via `deleted_at`. No hard
-- delete path exists. `author_id` is the users.id resolved from the
-- session email at write time; the display name is derived on read.
CREATE TABLE "builder_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" uuid NOT NULL,
	"visibility" text DEFAULT 'org' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "builder_comments_entity_idx" ON "builder_comments" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "builder_comments_entity_visibility_idx" ON "builder_comments" USING btree ("entity_id","visibility");
