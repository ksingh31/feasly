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

### BE0-004 — TypeScript 7 migration (5.9.3 → 7.x)
**Size:** M — Cross-cutting toolchain story. PR #141 (Dependabot, 5.9.3 → 7.0.2) was
closed as not a drop-in update; the migration needs dedicated effort touching
production code and tests.
**Description:** Bump `typescript` (devDependency) from 5.9.3 to 7.x across the
monorepo (`apps/api`, `apps/web`, `packages/cost-engine`, `packages/contracts`,
`packages/mcp`) and fix every breaking change. Known breakage categories (from the
PR #141 CI failure, run 36195203419):
1. **Stricter implicit-any (TS7006):** parameters in callbacks that relied on
   contextual typing now fail — e.g. `apps/api/src/services/estimate.service.ts`,
   assorted test files.
2. **Unknown catch variables (TS18046):** `catch (error)` variables are `unknown`
   instead of `any` — narrow or type-guard before use (e.g. `estimate.service.ts`).
3. **Changed lib defaults:** `console` / `process` no longer found in some files
   (e.g. `packages/mcp/src/stdio.ts`) — explicit `lib`/`types` entries in the
   affected tsconfigs rather than relying on TS defaults.
4. **Project-reference resolution changes:** `@feasly/cost-engine`,
   `@feasly/contracts`, `@feasly/mcp` modules fail to resolve under the standalone
   `tsc -b` reference build — align with how CI builds references (root
   `npx tsc -b`, not bare per-project `tsc`).
5. **Stricter excess-property checks:** `ProblemDetails` object literals with
   `code`/`retryable` now fail — type against the `ApiError` contract explicitly.
**Acceptance criteria:**
- Root `npx tsc -b` (the canonical CI typecheck) is fully clean — zero errors.
- Full test suite green on the same commit (no test-skipping to get there).
- No behavior changes: the migration is type-level only; no API contract,
  pricing-math, or UI behavior changes.
- Dependabot TS 7.x PRs are green after this lands (no more manual close-out).
**Tests:** existing suite must stay green; add no new tests unless a type fix
exposes a real behavior gap (then add a regression test per the bug rule).
**Dependencies:** none (orthogonal to all stories; land it in a quiet window —
rebasing main fast invalidates the typecheck quickly).
