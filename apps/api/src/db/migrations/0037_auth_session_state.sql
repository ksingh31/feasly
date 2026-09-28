-- Session state for the auth/04 permission model.
--
-- admin_sessions gains two nullable columns:
--   active_builder_id — the session's active builder tenant. Users with
--     several builder memberships pick one (at sign-in default, or via the
--     org switcher); the choice lives server-side in the session, never in
--     a request param. Tenant scoping reads this, never a client value.
--   view_as — JSONB: {"builderId": "..."} or {"userId": "..."}. While set,
--     effective permissions + tenant scoping resolve to the target's; the
--     real admin's identity is preserved for the audit trail.
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "active_builder_id" uuid REFERENCES "builders"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "view_as" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_sessions_active_builder_idx" ON "admin_sessions" ("active_builder_id");
