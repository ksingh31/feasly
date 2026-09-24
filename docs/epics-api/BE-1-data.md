# BE-1 — Data layer (Drizzle + PostgreSQL)

### BE1-001 — Drizzle setup, migrations, core schema
**Size:** L
**Description:** Drizzle client constructed once in `composition.ts` from config and
injected into services — never imported by routes. Migration runner wired to the
deploy pipeline (`drizzle-kit migrate` before the Functions deploy; dev uses
`db:push`). Tables (see `~/workspace/feasly/plan/SCHEMA.md` for the full model):
`leads`, `estimates`, `estimate_snapshots` (immutable, figures as JSONB),
`magic_link_tokens` (hashed, single-use, expiry), `callbacks`, `builders/tenants`,
`communities`. All timestamps `timestamptz`; money as `numeric`, never float.
**Acceptance criteria:**
- Fresh database → migrations apply cleanly; `health` DB ping returns healthy.
- Snapshot rows are insert-only (no update/delete path exists in the data layer).
- Magic-link tokens stored hashed; plaintext token never persisted.
**Tests:** migration up/down on a scratch database (CI Postgres service);
schema snapshot test (unexpected column changes fail loudly).
**Dependencies:** BE-0.

### BE1-002 — Dev seed script
**Size:** S
**Description:** `npm run seed` inserts a deterministic dev dataset (one builder,
sample communities, a lead + estimate + snapshot chain) for local development and
demos. Idempotent; refuses to run against production (config guard).
**Tests:** seed twice → no duplicates.
**Dependencies:** BE1-001.
