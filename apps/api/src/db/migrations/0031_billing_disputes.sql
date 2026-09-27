-- Dispute console (billing/01 follow-on, was OPS-009): `billing_disputes`
-- table. One row per builder dispute, opened when an invoice moves to
-- 'disputed'; carries the IMMUTABLE evidence snapshot (invoice money/state
-- at dispute-open time) and the 5-business-day America/Edmonton SLA
-- deadline. A breach escalates via ops alerts — it never auto-resolves.
--
-- Every statement is IF NOT EXISTS: on a healthy database this migration
-- is a no-op; on a drifted one (see the 0025/0028 repair notes) it
-- restores the table/indexes the Drizzle schema selects.
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_disputes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "invoice_id" uuid NOT NULL REFERENCES "commission_invoices"("id"),
  "tenant_key" text NOT NULL REFERENCES "tenants"("tenant_key"),
  "reason" text NOT NULL,
  "evidence_snapshot" jsonb NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sla_due_at" timestamp with time zone NOT NULL,
  "sla_breached_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "resolved_by" text,
  "resolution_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_disputes_status_opened_idx" ON "billing_disputes" USING btree ("status","opened_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_disputes_invoice_idx" ON "billing_disputes" USING btree ("invoice_id");
