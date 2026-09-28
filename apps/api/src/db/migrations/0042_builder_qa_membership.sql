-- Builder QA membership (2026-09-28).
--
-- Karan's builder sign-in 403'd with "We couldn't find your Feasly builder
-- account — ask your builder admin for an invite." The Entra exchange itself
-- succeeded (code redeemed, id_token validated): his user row exists (the
-- protected super_admin seed from 0036), but it had no builder_memberships
-- row, and the callback service 403s membership-less users.
--
-- The admin invite UI cannot touch protected rows, so this idempotent data
-- migration grants him builder_admin on the seeded Elite Craft Builders org
-- (0035) — the same outcome as accepting a builder invite. His first
-- builder sign-in links his Entra object id through the normal callback
-- path (direct-link branch for protected rows).
--> statement-breakpoint
INSERT INTO "builder_memberships" ("id", "user_id", "builder_id", "role")
SELECT
  'a39ec450-81f2-4060-baef-afcebed829ac',
  u."id",
  'a506cc36-ffd1-42db-993c-999bfbb0f1d2',
  'builder_admin'
FROM "users" u
WHERE u."email" = 'karanbirsingh667@gmail.com'
ON CONFLICT ("user_id", "builder_id") DO NOTHING;
