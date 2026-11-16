-- #800: household magic links.
--
-- `household`: true for owner links minted by the reissue path and
-- delivered only by email — the only links that list a household's other
-- estimates. Existing rows default to false (they keep opening their own
-- report, exactly as before). Has a default, so NOT NULL is safe in one step.
ALTER TABLE "magic_links" ADD COLUMN IF NOT EXISTS "household" boolean DEFAULT false NOT NULL;
