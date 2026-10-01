-- Builder-side view-as session state (2026-09-30, Karan).
--
-- builder_sessions gains a nullable view_as jsonb column mirroring
-- admin_sessions.view_as (0037): while set, the session's effective
-- permissions + tenant scoping resolve to the TARGET user's view
-- (regular org members only — enforced in builder-view-as.service.ts,
-- never escalates, audit-logged under the real builder admin's identity).
-- Null = not viewing-as. Builder-side targets are userId-only.
--> statement-breakpoint
ALTER TABLE "builder_sessions" ADD COLUMN "view_as" jsonb;
