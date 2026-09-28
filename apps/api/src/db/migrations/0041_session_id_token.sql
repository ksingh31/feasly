-- Logout UX (2026-09-28): store the Entra id_token on session rows so logout
-- can return it as `id_token_hint` for the Microsoft end-session redirect
-- (skips the "Pick an account" picker). Nullable: legacy sessions minted
-- before this change have no token; logout falls back to no hint.
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "id_token" text;
--> statement-breakpoint
ALTER TABLE "builder_sessions" ADD COLUMN "id_token" text;
