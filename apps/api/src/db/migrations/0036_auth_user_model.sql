-- Users, builder memberships, invitations (auth/01).
--
-- Password-based identity for Feasly staff and builder org members. The
-- allowlist tables (admin_allowlist, builder_allowlist) stay untouched —
-- auth/06 migrates them onto this model.
--
-- users.email is the unique identity (lowercased + trimmed by app
-- discipline, same as the allowlists). password_hash is null until the
-- invitation is accepted — Karan's seed row below is 'invited' so he sets
-- his password through the invite flow like everyone else.
--> statement-breakpoint
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY,
  "email" text NOT NULL UNIQUE,
  "password_hash" text,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'invited',
  "staff_role" text,
  "is_protected" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_idx" ON "users" ("email");
--> statement-breakpoint
-- A user can belong to multiple builders (rare, but built for). The role is
-- per-membership. Both FKs cascade — deleting a user or a builder removes
-- the membership, never orphans it.
CREATE TABLE "builder_memberships" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "builder_id" uuid NOT NULL REFERENCES "builders"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builder_memberships_user_builder_idx"
  ON "builder_memberships" ("user_id", "builder_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_memberships_builder_idx"
  ON "builder_memberships" ("builder_id");
--> statement-breakpoint
-- Email invitations: only the SHA-256 hash of the opaque token is stored
-- (same discipline as sessions / magic links). An invitation can grant a
-- staff role, a builder membership, or both.
CREATE TABLE "invitations" (
  "id" uuid PRIMARY KEY,
  "email" text NOT NULL,
  "staff_role" text,
  "builder_id" uuid REFERENCES "builders"("id") ON DELETE CASCADE,
  "builder_role" text,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "accepted_at" timestamptz,
  "revoked_at" timestamptz,
  "invited_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_token_hash_idx" ON "invitations" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_email_idx" ON "invitations" ("email");
--> statement-breakpoint
-- Sessions gain the user link (nullable during the magic-link → password
-- transition; always set for password sessions).
ALTER TABLE "admin_sessions" ADD COLUMN "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "builder_sessions" ADD COLUMN "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Seed: Karan's super_admin row, derived from the admin_allowlist seed.
-- Fixed UUID keeps it deterministic across environments. Status 'invited'
-- with no password hash — he sets his password via the invite flow
-- (auth/02+ resend/accept). is_protected blocks API edit/delete.
INSERT INTO "users"
  ("id", "email", "name", "status", "staff_role", "is_protected")
SELECT
  '805793cc-5aca-46f4-9498-996c784aee5a',
  'karanbirsingh667@gmail.com',
  'Karan',
  'invited',
  'super_admin',
  true
WHERE EXISTS (
  SELECT 1 FROM "admin_allowlist" WHERE "email" = 'karanbirsingh667@gmail.com'
)
ON CONFLICT ("email") DO NOTHING;
