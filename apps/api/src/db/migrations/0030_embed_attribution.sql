-- EMB-03 embed lead attribution: the attribution feature persists the
-- validated embed tenant key on the estimates row (estimate.store writes
-- `tenantKey` on insert), so the column must exist.
-- NOTE: `leads.tenant_key` has existed since the 0000 base migration; this
-- adds the estimates-side column only. A prior generation wrongly dropped
-- this migration as "redundant" (confusing the leads column for the
-- estimates one); it is required — without it, embed estimate inserts fail.
ALTER TABLE "estimates" ADD COLUMN "tenant_key" text;
--> statement-breakpoint
