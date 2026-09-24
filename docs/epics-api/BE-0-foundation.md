# BE-0 — Backend foundation

Establishes the layered skeleton every later story builds on. No business logic yet.

### BE0-001 — Layered scaffold, composition root, boundary enforcement
**Size:** M
**Description:** Rework `apps/api/src` into `routes/ services/ db/ middleware/ lib/`
plus `config.ts` and `composition.ts`. Keep the existing `health` function working.
Every service gets `interface XxxService` + `createXxxService(deps)` factory;
`composition.ts` is the only place concretes are constructed. A boundary test
(`test/boundaries.test.ts`) asserts: nothing under `routes/` or `middleware/`
imports from `db/`; nothing outside `config.ts` reads `process.env` directly.
**Acceptance criteria:**
- `func start` (or `npm run build`) works; `/api/health` still 200.
- Boundary test fails if a route imports `db/` (prove it by a temporary violation).
- README documents the layer diagram and the "db only in services" rule.
**Tests:** boundary test; composition test (all services resolve, no undefined).
**Dependencies:** none.

### BE0-002 — Typed config, zero hardcoding
**Size:** S
**Description:** `src/config.ts`: zod schema over env (`DATABASE_URL`, rate-limit
values, JWT TTLs, magic-link TTL, CORS origins, queue names…). Fails fast with a
readable error at startup when required env is missing or invalid. CI grep fails on
`process.env` outside `config.ts` and on literal URLs/timeouts in `routes/` or
`services/`.
**Acceptance criteria:**
- Missing `DATABASE_URL` → startup error naming the variable (not a cryptic crash).
- Every limit/TTL used by later stories comes from config (spot-check list in PR).
**Tests:** config parses valid env; rejects invalid (bad URL, negative TTL).
**Dependencies:** BE0-001.

### BE0-003 — Middleware: errors, correlation, health, rate limiting
**Size:** M
**Description:** `middleware/errorHandler` maps thrown errors to RFC 7807
ProblemDetails matching the `ApiError` contract (never stack traces to clients).
`correlationId` propagates `x-correlation-id` (or generates one) into logs.
`rateLimit` is a reusable in-memory limiter (config-driven limits) applied to
public routes; 429 responses use the `RATE_LIMITED` error code. Extend `health`
with a DB ping (BE-1 wires the real check; here it returns `degraded` cleanly
when the DB is unreachable rather than 500ing).
**Acceptance criteria:**
- Unknown throw in a route → 500 ProblemDetails, no stack, correlation ID present.
- 11th request in the window → 429 with `RATE_LIMITED`.
**Tests:** error mapping table; rate-limit window behavior (fake timers).
**Dependencies:** BE0-001, BE0-002.
