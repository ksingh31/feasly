# EPIC 07 — Public API + MCP Server

**Owner:** TPM (implementation epics)
**Milestone coverage:** M5 (BUILD_PLAN) — agent-friendly API + MCP
**Status:** not started — blocked until M1 web engine + lead pipeline exist

## Goal

Expose Feasly's property data, deterministic cost engine, and lead pipeline as a
versioned public API (`/api/v1`) and an MCP server, so AI agents and builder
integrations can call Feasly natively mid-conversation. The human web UI, the
REST API, and the MCP server share one cost engine and one lead pipeline — no
duplicated logic. API keys ship with scopes, per-key rate limits, and usage
metering from day one (metering makes future per-estimate billing possible
without a schema migration).

## Non-goals

- Per-estimate billing/charging (metering only; billing is future work owned by
  whoever builds the billing epic).
- GraphQL, additional API versions, or public write access beyond the three
  tools (no admin endpoints on the public surface).
- Outbound / agent-driven lead follow-up (deferred past MVP per ADR-001).
- A public self-serve signup for API keys (issuance is admin-driven in M5;
  self-serve is a later business decision).

## Key decisions

1. **Endpoints (tool → route):** `get_property` → `GET /api/v1/property?address=…`;
   `estimate_project` → `POST /api/v1/estimates`; `submit_lead` →
   `POST /api/v1/leads`. Read-only companions: `GET /api/v1/estimates/{id}`,
   `GET /api/v1/leads` (key's own records only).
2. **Auth:** `Authorization: Bearer <key>`. Keys prefixed `feasly_live_` /
   `feasly_test_`; only `key_hash` (sha256) is stored — `api_keys` in SCHEMA.md
   already models this.
3. **zod is the single source of truth:** request/response schemas are zod
   schemas; the OpenAPI 3.1 spec is generated from them
   (`@asteasolutions/zod-to-openapi`) and served at `/api/v1/openapi.json`.
   Hand-maintaining a parallel spec is banned.
4. **Uniform error envelope (every error, every route):**
   `{ "error": { "code": "SNAKE_CASE", "message": "…", "requestId": "…" } }`
   with a matching HTTP status.
5. **Scopes:** `property:read`, `estimate`, `estimate:read`, `lead`, `lead:read`.
   Default issuance: `property:read, estimate, lead` (schema default updated —
   logged in assumptions).
6. **Rate limiting:** per `api_keys.rate_limit` (requests/minute), sliding
   window; `429` + `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
   `X-RateLimit-Reset` headers.
7. **MCP transport: stdio + hosted Streamable HTTP.** stdio covers local
   agent tooling and testing with zero infra; the hosted server is a single
   Streamable HTTP endpoint `POST /mcp/v1` on the same Function App, reusing
   the REST auth middleware, scope checks, and rate limiter. Justification:
   the MCP 2025-03 spec made Streamable HTTP the standard remote transport and
   deprecated SSE for new integrations — one HTTP endpoint keeps infra,
   observability, and security posture identical to the REST API.
8. **Same-engine guarantee:** contract tests prove byte-identical `outputs`
   across web handler, REST handler, and MCP tool for identical
   `(inputs, cost_data_version)`.
9. **Sandbox:** `feasly_test_` keys run the real engine against the real
   frozen cost data, but writes carry `sandbox=true`, leads never send email
   or sync to Sheets, and sandbox rows auto-purge after 30 days.
10. **Versioning policy:** URL versioning; v1 frozen once stable; breaking
    changes ship as v2 with `Deprecation`/`Sunset` headers and 6 months notice.

---

## Stories (dependency order)

### API-001 — Shared service layer extraction
**Description:** Refactor the M1–M3 web handlers so all business logic lives in
shared services (`property-data`, `estimate`, `lead`) that the web UI, REST
API, and MCP server all call. This is the structural guarantee behind "no
duplicated logic" — the API cannot drift from the web UI because there is only
one implementation.

**Acceptance criteria:**
- `apps/api/src/services/property-data.ts`, `estimate.ts`, `lead.ts` exist;
  each is pure logic over injected clients (no HTTP framework types leak in).
- All existing web routes (address lookup, estimate, lead gate) call these
  services; no cost math or lead scoring remains inline in route handlers
  (verified by grep for `per_sqft|lead_score` outside services/ + engine).
- Existing M1 end-to-end tests pass unmodified.

**Dependencies:** M1–M3 web handlers exist.
**Size:** M

### API-002 — API key issuance + storage
**Description:** Admin-only key issuance. `POST /api/v1/admin/api-keys`
(admin auth) accepts `{ name, tenant_id?, scopes[], rate_limit? }`, returns the
plaintext key **once** (`feasly_live_…` / `feasly_test_…`), and stores only the
sha256 `key_hash`. Rotation issues a new key and revokes the old; revocation
is immediate.

**Acceptance criteria:**
- Plaintext key is returned exactly once and never again (subsequent GETs show
  masked `feasly_live_…abcd`).
- DB contains only the hash; a test asserts no plaintext or reversible form
  exists in `api_keys`.
- `scopes` validated against the allowlist; unknown scope → `422 VALIDATION_ERROR`.
- `rate_limit` defaults to 100 req/min when omitted.
- Rotate: old key returns `401 INVALID_API_KEY` within 60 seconds.

**Dependencies:** API-001; M4 admin auth.
**Size:** M

### API-003 — Auth middleware + scope enforcement + error envelope
**Description:** Shared middleware for every `/api/v1/*` route: Bearer parsing,
key lookup by hash, `active` check, per-route scope check, `requestId`
generation (propagated to logs), and the uniform error envelope.

**Acceptance criteria:**
- Missing/malformed key → `401` with `code: "INVALID_API_KEY"`.
- Valid key, wrong scope → `403` with `code: "INSUFFICIENT_SCOPE"`.
- Revoked/inactive key → `401 INVALID_API_KEY`.
- Every error response (including 404/500 paths) matches the envelope shape
  exactly; `requestId` appears in structured logs for the request.
- Unit tests cover all four cases.

**Dependencies:** API-002.
**Size:** M

### API-004 — `GET /api/v1/property` (get_property)
**Description:** Property lookup reusing the property-data service: `?address=`
(required), `?city=` (default `calgary`). Cache-first via the `properties`
table; Socrata fetch only on cache miss. Returns the same fields as the web
property card (assessed value, neighbourhood, zoning/land use, lot size, year
built) — nothing more.

**Acceptance criteria:**
- For 3 fixture addresses, API response deep-equals the web S1 property card
  data (contract test).
- Second identical call does not hit Socrata (assert via fetch counter / cache
  `fetched_at` unchanged).
- Unknown/non-Calgary address → `404 PROPERTY_NOT_FOUND` envelope with the
  same guidance copy as the web UI ("Feasly currently covers Calgary only").
- Requires `property:read` scope.

**Dependencies:** API-001, API-003.
**Size:** M

### API-005 — `POST /api/v1/estimates` (estimate_project)
**Description:** Estimate creation through the shared estimate service. Body is
the zod `EstimateInput` schema (project_type, city, sqft, tier, address_key /
reno / neighbourhoods). Runs the engine against the active frozen
`cost_data_version`, writes an immutable `estimates` row with
`source='api'`, writes an `api_usage` row linking `estimate_id`, and returns
ranges + assumptions + `cost_data_version` + estimate id. Read-only companion
`GET /api/v1/estimates/{id}` returns the key's own estimates.

**Acceptance criteria:**
- 12 fixture inputs (all 3 project types × tiers) return the pinned ranges
  from `packages/cost-engine` fixtures — API adds no math of its own.
- Serialized response contains no `per_sqft`, `margin`, or param tables
  (secret-leak test, same deny-list as the engine).
- Invalid tier / negative sqft → `422 VALIDATION_ERROR` naming the field.
- Each call writes exactly one `api_usage` row with `endpoint`,
  `api_key_id`, `estimate_id`.
- `GET /api/v1/estimates/{id}` returns `404` for another key's estimate
  (tenant isolation test).

**Dependencies:** API-003, API-004 (address resolution path for new_build).
**Size:** M

### API-006 — `POST /api/v1/leads` (submit_lead)
**Description:** Lead submission through the shared lead service with
idempotency. Body: `estimate_id`, name, email, phone (optional), timeline,
`consent_marketing` (bool, default false), `consent_privacy` (bool, required
true — PIPEDA meaningful consent). `Idempotency-Key` header: replays return
the original `200` with the original lead id; no duplicate lead. Same
hot/warm/cold scoring and same email+address 90-day dedupe as the web gate.
`source='api'`.

**Acceptance criteria:**
- Same payload + same `Idempotency-Key` twice → one `leads` row, second
  response `200` with identical lead id (not `201`).
- Missing/false `consent_privacy` → `422 VALIDATION_ERROR`.
- `consent_ts` recorded; `consent_marketing=false` default respected.
- Lead scoring matches web behavior for all 5 timelines (hot/warm/cold table test).
- 90-day email+address dedupe: second lead updates the existing lead instead
  of duplicating (same rule as web).

**Dependencies:** API-003, API-005, M4 lead pipeline.
**Size:** M

### API-007 — Per-key rate limiting
**Description:** Sliding-window rate limiter enforcing `api_keys.rate_limit`
(requests/minute) on every public route. Backed by the `api_usage` table
(no new infra at MVP volume — logged as a decision). `429` responses carry
`code: "RATE_LIMITED"` plus `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset` headers.

**Acceptance criteria:**
- With `rate_limit=5`, the 6th request inside 60s → `429 RATE_LIMITED`;
  headers show `Limit: 5`, `Remaining: 0`, and a `Reset` epoch within the
  current window.
- Window slides: requests older than 60s stop counting (time-mocked test).
- Rate limiting applies per key, not per IP (two keys on one IP are
  independent — test).
- 429s do not write `api_usage` rows (no metering of rejected calls).

**Dependencies:** API-003.
**Size:** M

### API-008 — Usage metering reads
**Description:** `GET /api/v1/admin/usage?key_id=&from=&to=` returns per-day
counts grouped by endpoint, plus estimate counts — the raw material for
future per-estimate billing. Surfaced in the key-management UI as a per-key
usage panel.

**Acceptance criteria:**
- Aggregates reconcile exactly with `api_usage` rows for the window (test
  with seeded rows).
- Key owners see only their own key's usage; admins see all (auth test).
- Response includes `estimates_created` count (billing-ready signal).

**Dependencies:** API-005, API-006, API-009.
**Size:** S

### API-009 — API key management UI
**Description:** Admin route (Angular, admin-only) listing keys (masked),
issuing new keys (plaintext shown once with copy button), rotate, revoke,
edit scopes / rate_limit, and a usage panel per key (from API-008). Every
key event (created, rotated, revoked, scope changed) is audit-logged.

**Acceptance criteria:**
- Create → key displayed once; navigating away loses it (never re-fetchable).
- Revoke → key returns `401` within 60s.
- Scope/rate-limit edits take effect on the next request (no restart).
- Audit log lists all key events with actor + timestamp.
- Non-admin users get a `403` on the route (route guard test).

**Dependencies:** API-002, M4 admin auth.
**Size:** M

### API-010 — OpenAPI 3.1 spec generation
**Description:** Generate `openapi.json` (3.1) from the zod schemas at build
time; serve at `GET /api/v1/openapi.json`; version the spec alongside the
API. CI fails if the spec drifts from the code.

**Acceptance criteria:**
- Spec validates cleanly (Redocly CLI / Spectral, zero errors).
- Every public route, schema, scope, and error code appears in the spec.
- CI job regenerates the spec and diffs it — any drift fails the build.
- `servers` lists production + sandbox base URLs.

**Dependencies:** API-004, API-005, API-006.
**Size:** M

### API-011 — Developer docs page
**Description:** Prerendered `/developers` page (Angular, SEO-friendly):
quickstart (5-minute curl example), auth, scopes table, rate limits, error
code catalog, idempotency guide, sandbox mode, and a changelog. Links the
OpenAPI spec and an interactive API reference (Scalar/Redoc).

**Acceptance criteria:**
- All curl/code samples in the docs are executed in CI against the sandbox
  (or lint-checked) — no stale examples.
- Page is prerendered with full meta/OG tags (per the SEO-first directive).
- Changelog documents the v1 freeze date and the deprecation policy.

**Dependencies:** API-010, API-014.
**Size:** M

### API-012 — MCP server package
**Description:** `packages/mcp/` — thin wrapper exposing three tools:
`get_property`, `estimate_project`, `submit_lead`. Tool input schemas are the
same zod schemas as the REST API; each tool calls the same shared services.
Two transports: stdio entry (`packages/mcp/dist/stdio.js`) for local agent
tooling, and Streamable HTTP mounted at `POST /mcp/v1` on the Function App
with Bearer API-key auth and per-tool scope checks
(`property:read` / `estimate` / `lead`).

**Acceptance criteria:**
- MCP Inspector connects to both stdio and `POST /mcp/v1` (with a test key).
- Each tool with fixture inputs returns deep-equal results to the
  corresponding REST endpoint (same test fixtures as API-004/005/006).
- Tool call without the required scope → MCP error (not silent success).
- `submit_lead` via MCP honors `Idempotency-Key` (passed as a tool argument).
- Package has zero cost-math of its own (grep: no `per_sqft`, no band
  constants outside the shared engine).

**Dependencies:** API-001, API-003.
**Size:** L

### API-013 — Same-engine contract tests
**Description:** The executable form of the same-engine guarantee. Shared
fixture file `packages/cost-engine/test/fixtures/api-contract.json` (≥12
cases covering all 3 project types, edge sqfts, all tiers). A test harness
runs each fixture through (a) the web handler path, (b) the REST handler,
(c) the MCP tool, and asserts deep-equal `outputs` and identical
`cost_data_version`.

**Acceptance criteria:**
- All three surfaces produce byte-identical `outputs` for every fixture
  (JSON-serialized comparison).
- Fixture regeneration is scripted (`pnpm contract:regen`); hand-edited
  fixtures fail a checksum test.
- Test runs in CI on every change to `packages/cost-engine`, `apps/api`
  services, or `packages/mcp`.
- A deliberate engine change without fixture regen fails loudly (verified by
  temporarily mutating a band in a scratch test — documented in the test).

**Dependencies:** API-005, API-012.
**Size:** M

### API-014 — Sandbox mode + playground
**Description:** `feasly_test_` key issuance (API-002), `sandbox` boolean
columns on `estimates` and `leads` (migration), sandbox enforcement: test-key
writes set `sandbox=true`, `submit_lead` in sandbox never sends Postmark
email and never syncs to Sheets, sandbox rows are excluded from all
production analytics, and a nightly job purges sandbox rows older than 30
days. Docs "Playground" section with a ready-made test key request flow.

**Acceptance criteria:**
- Test-key estimate + lead round-trip: rows exist with `sandbox=true`.
- No Postmark send is attempted for sandbox leads (assert via email-service
  mock call count = 0).
- Purge job: rows older than 30 days deleted; production rows untouched
  (seeded-data test).
- Admin UI clearly badges sandbox rows; they are excluded from lead counts.

**Dependencies:** API-002, API-006.
**Size:** M

### API-015 — Versioning policy + deprecation mechanics
**Description:** Documented API versioning policy (in developer docs): URL
versioning, v1 stability promise, what counts as breaking, 6-month
deprecation notice. Implement `Deprecation`/`Sunset` header middleware now
(unused in v1) so deprecations are a config flip later, plus a v1 freeze
checklist (spec locked, fixtures pinned, changelog entry).

**Acceptance criteria:**
- Policy page published under `/developers/versioning`.
- Header middleware unit-tested (emits `Deprecation: true` + `Sunset` date
  when a route is flagged).
- v1 freeze checklist completed and signed off in the repo
  (`docs/api-v1-freeze.md`).

**Dependencies:** API-010.
**Size:** S

### API-016 — API abuse monitoring
**Description:** Anomaly detection over `api_usage`: a key exceeding 3× its
trailing 7-day average, a Socrata miss-rate spike (proxy-abuse signal), or
repeated `401`s from a single IP triggers an admin alert (email to Feasly
team) and a dashboard widget. Complements HRD-005 (platform-wide abuse pass).

**Acceptance criteria:**
- Seeded anomalous usage fires exactly one alert per key per day (no spam).
- Widget on the admin dashboard shows top-10 keys by trailing-24h volume.
- Alert includes key name, tenant, and the offending pattern.

**Dependencies:** API-007, API-008.
**Size:** S

---

## Assumptions log

- A1: `api_keys.scopes` default changes from `{estimate,lead}` (SCHEMA.md) to
  `{property:read,estimate,lead}` — migration included in API-002.
- A2: Rate limiting is Postgres-backed on `api_usage` (no Redis) — simpler,
  correct at MVP volume; revisit if p99 latency on the limiter exceeds 50ms
  under load (measured in HRD-011).
- A3: No public self-serve key signup in M5 — issuance is admin-driven.
- A4: MCP Streamable HTTP (not SSE) per the MCP 2025-03 spec direction.
- A5: `estimates`/`leads` gain `sandbox boolean NOT NULL DEFAULT false` via
  migration in API-014.
- A6: `leads` gains `idem_key text` (nullable) + partial unique index on
  `(tenant_id, idem_key) WHERE idem_key IS NOT NULL` in API-006.

## Open questions

- Q1: Should API-issued estimates count toward the lead's "Updated {date}"
  versioning on the web report (UX_FLOW scenario 5)? (Recommendation: yes —
  one estimate history per user regardless of source.)
- Q2: Public rate-limit defaults — is 100 req/min right for launch partners,
  or tiered (e.g. 60 default / 600 trusted)? (Recommendation: 100 flat for M5;
  tiers when billing arrives.)
- Q3: Does Karan want the MCP server published to a public registry
  (npm) at M5, or kept private until the embed business validates?
  **NEEDS-KARAN.**
- Q4: Should `submit_lead` via API trigger the 24h nudge email sequence
  (M4+) the same as web leads? (Recommendation: yes — one pipeline.)
