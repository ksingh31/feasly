# BE-3 — Public API endpoints (`/api/v1`)

All routes thin: validate (zod) → call service interface → format response.
Contract-conformance tests assert every response validates against
`@feasly/contracts` fixtures.

### BE3-001 — POST /api/v1/property/search
**Size:** M — Address autocomplete via the City of Calgary Socrata API with a
short-TTL cache (config-driven). Never leaks Socrata internals; response is the
`Property` contract shape. **Tests:** cache hit/miss; Socrata outage → 503 `UPSTREAM_UNAVAILABLE`, not 500.

### BE3-002 — POST /api/v1/estimates (preview)
**Size:** M — Runs the engine, persists the immutable snapshot, returns
**preview only** (`PreviewEstimateResponse` — blurred figures, per BE2-002).
The route's return type makes leaking real figures a compile error.
**Tests:** response deep-equals blurred shape; snapshot row written.

### BE3-003 — POST /api/v1/leads
**Size:** M — Lead gate submit. zod validation (email required, phone optional,
CASL unchecked default honored), 90-day dedup window (config), idempotency key
support. Enqueues magic-link email (BE-5). **Tests:** duplicate within window →
same lead, no duplicate email; invalid email → 400 `VALIDATION_ERROR`.

### BE3-004 — Magic-link request + verify
**Size:** M — `POST /api/v1/magic-links` (rate-limited hard) and
`GET /api/v1/magic-links/verify?token=`. Single-use, hashed storage, TTL from
config. On verify: issues JWT in httpOnly cookie (see BE-4).
**Tests:** reuse of a token → 410; expired → 410; wrong token → 404 (no oracle).

### BE3-005 — GET /api/v1/reports/:token
**Size:** M — Full report behind the magic-link token: real figures, tier
what-if (re-runs engine with a different tier, new snapshot version), inline
adjust/re-run, next-three-steps. Token auth via `requireAuth`.
**Tests:** pre-gate token → 403; tier switch returns a new snapshot version.

### BE3-006 — Callback + share
**Size:** S — `POST /api/v1/callbacks` (request a call; notifies builder via
queue), `POST /api/v1/shares` (email report to partner). Both validated,
queued, never synchronous SMTP in the request path.

**Dependencies:** BE-0, BE-1, BE-2. (BE3-004/005 need BE-4's JWT issuance —
implement behind the `IAuthService` interface; BE-4 provides the real one.)
