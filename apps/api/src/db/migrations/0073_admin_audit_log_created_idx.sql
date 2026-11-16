-- Audit log viewer (#728). Index only — no column or data change.
--
-- The admin audit viewer pages `admin_audit_log` newest-first with a
-- (created_at, id) keyset cursor over the whole table; without this index
-- every page is a full sort.
CREATE INDEX IF NOT EXISTS "admin_audit_log_created_idx" ON "admin_audit_log" USING btree ("created_at");
