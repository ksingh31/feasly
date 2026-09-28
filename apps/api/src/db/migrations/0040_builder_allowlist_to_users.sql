-- Migrate builder_allowlist → users / builder_memberships / invitations (auth/05).
--
-- The allowlist was the pre-Entra gate: an email on the list could request a
-- magic link for a tenant. Under organization accounts, that pre-approval
-- becomes a real user row (status 'invited'), a builder_membership granting
-- builder_admin in the org, and an accepted invitation recording the grant.
--
-- Idempotent: re-running inserts nothing new (ON CONFLICT DO NOTHING on the
-- natural keys). The allowlist table itself is left in place — the magic-link
-- flow still reads it until it's retired.
--> statement-breakpoint
-- 1. Users: one row per allowlisted email. The name defaults to the email
-- local part; the user sets their display name at first Entra sign-in.
INSERT INTO "users" ("id", "email", "name", "status")
SELECT gen_random_uuid(), ba."email", split_part(ba."email", '@', 1), 'invited'
FROM "builder_allowlist" AS ba
ON CONFLICT ("email") DO NOTHING;
--> statement-breakpoint
-- 2. Memberships: link each user to the builder whose tenant_key matches the
-- allowlist row. Allowlisted emails were the org's admins → builder_admin.
INSERT INTO "builder_memberships" ("id", "user_id", "builder_id", "role")
SELECT gen_random_uuid(), u."id", b."id", 'builder_admin'
FROM "builder_allowlist" AS ba
JOIN "users" AS u ON u."email" = ba."email"
JOIN "builders" AS b ON b."tenant_key" = ba."tenant_key"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 3. Invitations: record the grant. Status 'accepted' — the allowlist WAS the
-- approval, so these aren't pending invites; they're the audit trail of the
-- migration. Expires_at is set far future; accepted rows never expire.
-- Idempotency guard: invitations has no natural unique key, so skip rows
-- this migration already wrote.
INSERT INTO "invitations" ("id", "email", "role", "builder_id", "status", "expires_at")
SELECT gen_random_uuid(), ba."email", 'builder_admin', b."id", 'accepted', now() + interval '100 years'
FROM "builder_allowlist" AS ba
JOIN "builders" AS b ON b."tenant_key" = ba."tenant_key"
WHERE NOT EXISTS (
  SELECT 1 FROM "invitations" AS i
  WHERE i."email" = ba."email"
    AND i."builder_id" = b."id"
    AND i."role" = 'builder_admin'
    AND i."status" = 'accepted'
);
