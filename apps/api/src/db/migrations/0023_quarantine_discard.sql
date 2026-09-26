-- admin/02 follow-up: quarantine approve/discard actions.
--
-- Adds `leads.discarded` — set when an admin discards a honeypot-flagged
-- lead via `POST /api/v1/admin/leads/{id}/quarantine/discard`. Discarded
-- rows are kept for audit but excluded from every listing and count (admin
-- list, quarantine tab, consumer lists, Sheets sync). `quarantined` stays
-- true on discard so all existing quarantine exclusions keep working;
-- `discarded` distinguishes "reviewed and thrown away" from "pending
-- review". Approving a lead clears both flags.
ALTER TABLE "leads" ADD COLUMN "discarded" boolean DEFAULT false NOT NULL;
