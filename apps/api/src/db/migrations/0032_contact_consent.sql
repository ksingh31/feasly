-- Contact-consent opt-out (Karan directive 2026-09-27: "opt out anytime" must be
-- real). Granular per-lead flags with timestamps:
--   contact_opt_out_at — calls/messages from Feasly and builders associated
--     with us; NULL = gate consent still stands. Proactive outreach must
--     exclude leads while this is set.
--   consent_updated_at — last change to ANY consent flag (gate capture,
--     one-click unsubscribe, preference-page save). Powers the admin
--     "Contact consent" column date and Sheets change detection.
--
-- Every statement is IF NOT EXISTS: on a healthy database this migration
-- is a no-op; on a drifted one it restores the columns the Drizzle schema
-- selects (see the 0025/0028/0030 repair notes).
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "contact_opt_out_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "consent_updated_at" timestamp with time zone DEFAULT now() NOT NULL;
