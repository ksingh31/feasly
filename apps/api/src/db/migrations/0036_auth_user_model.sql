-- Users, builder memberships, invitations (auth/01 — Entra External ID).
--
-- Entra owns the credential: we store only the Entra object id
-- (users.entra_object_id, null until first sign-in). No passwords, no
-- tokens, no password hashes anywhere in this schema.
--
-- The allowlist tables (admin_allowlist, builder_allowlist) stay untouched —
-- auth/06 migrates them onto this model.
--
-- users.email is the unique identity (lowercased + trimmed by app
-- discipline, same as the allowlists).
--> statement-breakpoint
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY,
  "email" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'invited',
  "staff_role" text,
  "entra_object_id" text UNIQUE,
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
-- Email invitations: admin invites → Graph create-user → invitation row →
-- branded email linking to /admin/login. `role` is the single granted
-- role: a staff role when builder_id is null, a builder role when set.
-- `status` is the lifecycle: pending → accepted | revoked. `entra_user_id`
-- is set from the Graph response at invite time — never logged, never
-- emailed.
CREATE TABLE "invitations" (
  "id" uuid PRIMARY KEY,
  "email" text NOT NULL,
  "invited_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "role" text NOT NULL,
  "builder_id" uuid REFERENCES "builders"("id") ON DELETE CASCADE,
  "entra_user_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_email_idx" ON "invitations" ("email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_entra_user_id_idx" ON "invitations" ("entra_user_id");
--> statement-breakpoint
-- Sessions gain the user link (nullable during the magic-link → Entra
-- transition; always set for Entra sessions).
ALTER TABLE "admin_sessions" ADD COLUMN "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "builder_sessions" ADD COLUMN "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Seed: Karan's super_admin row, derived from the admin_allowlist seed.
-- Fixed UUID keeps it deterministic across environments. entra_object_id
-- stays NULL until it is linked during the Azure tenant setup.
-- is_protected blocks API edit/delete.
INSERT INTO "users"
  ("id", "email", "name", "status", "staff_role", "entra_object_id", "is_protected")
SELECT
  '805793cc-5aca-46f4-9498-996c784aee5a',
  'karanbirsingh667@gmail.com',
  'Karan',
  'invited',
  'super_admin',
  NULL,
  true
WHERE EXISTS (
  SELECT 1 FROM "admin_allowlist" WHERE "email" = 'karanbirsingh667@gmail.com'
)
ON CONFLICT ("email") DO NOTHING;
