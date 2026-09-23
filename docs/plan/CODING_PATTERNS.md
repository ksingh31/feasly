# Feasly — Coding Patterns

**Status:** Law for all implementation. Concrete over abstract; the simpler option wins; deviations are recorded here, not drifted into silently.
**Stack anchor:** [ADR-001](../adr/ADR-001-architecture.md) · Build plan: [BUILD_PLAN.md](./BUILD_PLAN.md) · Schema: [SCHEMA.md](./SCHEMA.md) · Engine spec: [COST_ENGINE.md](./COST_ENGINE.md) · UX flow: [UX_FLOW.md](./UX_FLOW.md)

---

## 1. Repo layout + npm workspaces

```
feasly/
  apps/web/              # Angular 18 consumer site + /embed route + builder dashboard
  apps/api/              # Azure Functions (TypeScript/Node)
  packages/cost-engine/  # deterministic engine — pure TS, zero I/O, zero deps
  packages/contracts/    # shared DTOs + zod schemas (REST + postMessage)
  packages/embed-loader/ # vanilla JS loader snippet (<5KB, no framework)
  packages/mcp/          # MCP server (thin wrapper over cost-engine + contracts)
  packages/eslint-config/# shared flat eslint config (Section 2)
  packages/tsconfig/     # shared tsconfig.base.json + per-project variants
  infra/bicep/
  .github/workflows/
  package.json           # workspaces: ["apps/*", "packages/*"], private: true
```

### Workspaces wiring

- Root `package.json` declares `"workspaces": ["apps/*", "packages/*"]` and owns
  shared devDeps (vitest, playwright, zod, typescript, eslint, prettier).
  Apps/packages reference sibling packages by version `"workspace:*"`:
  `apps/api` depends on `@feasly/cost-engine` and `@feasly/contracts` via
  `"@feasly/cost-engine": "workspace:*"`.
- `apps/web` is Angular — it does **not** import from `packages/cost-engine`
  (Section 4: engine must never ship in the browser bundle). It imports
  `@feasly/contracts` for DTO types and zod schemas of *responses* it renders.
- `packages/mcp` imports `@feasly/cost-engine` and `@feasly/contracts`; it never
  touches `apps/api` internals.

### Build order

Turborepo is **not** used at MVP (extra infra). Order is enforced via
**TypeScript project references** and `npm run build` scripts that use
`tsc -b`:

```json
// packages/contracts/tsconfig.json
{
  "extends": "@feasly/tsconfig/node.json",
  "compilerOptions": { "composite": true, "outDir": "dist", "rootDir": "src" },
  "references": []
}
// apps/api/tsconfig.json
{
  "extends": "@feasly/tsconfig/node.json",
  "compilerOptions": { "composite": true, "outDir": "dist", "rootDir": "src" },
  "references": [
    { "path": "../../packages/contracts" },
    { "path": "../../packages/cost-engine" }
  ]
}
```

`npm run build` at root: `npm run build -w @feasly/contracts -w @feasly/cost-engine && npm run build --workspaces --if-present`. CI runs `tsc -b` from the root
project file, which builds references in dependency order automatically.
Circular references are forbidden and `tsc -b` fails on them — that is the guard.

### Shared configs

- `packages/tsconfig/tsconfig.base.json`: `strict: true` + full strict family
  (Section 2). Variants: `node.json` (ES2022, NodeNext) and `angular.json`
  (used by apps/web).
- `packages/eslint-config/index.js`: flat config exporting the repo ruleset;
  every app/package extends it (`import config from '@feasly/eslint-config'`).
- `.nvmrc` pins the Node LTS at repo creation. All packages use the same
  TypeScript and zod versions (hoisted at root).

---

## 2. TypeScript conventions

### Strict mode (non-negotiable)

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true,
  "forceConsistentCasingInFileNames": true,
  "noErrorTruncation": false
}
```

`strict` covers `noImplicitAny`, `strictNullChecks`, etc. The extra four catch the
bugs that strict alone misses in this codebase (indexing `jsonb` columns,
switch dispatch on `project_type`).

### ESLint highlights (flat config, `@feasly/eslint-config`)

```js
// packages/eslint-config/index.js (excerpt)
export default [
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/naming-convention': ['error',
        { selector: 'interface', format: ['PascalCase'] },
        { selector: 'typeAlias', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['UPPER_CASE'] }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.name='require']", message: 'Use ESM import.' },
        { selector: "TSEnumDeclaration", message: 'Use a const object + union type instead of enums.' }]
    }
  }
];
```

Notes:
- `no-console` bans stray `console.log` (Azure Functions use the context logger
  injected via the binding; web uses nothing — no client logging of PII).
- **No enums.** String unions + const objects, e.g. `type ProjectType = 'new_build' | 'renovation' | 'comparison'`. Matches the DB CHECK constraints and
  zod schemas exactly.

### `any` policy: banned, with two approved escape hatches

`@typescript-eslint/no-explicit-any` is `error` repo-wide. When you need the
escape:

1. **`unknown` + narrowing** (default). If you can narrow it, use it.
2. **`SafeAny` documented hatches only** — the two sanctioned places:
   - Jsonb columns read from Postgres before zod parsing: cast through a
     `parseXColumn` helper in `contracts` that immediately validates with zod.
   - The embed-loader's defensive globals (Section 7): `const w = window as unknown as Record<string, unknown>`.

Every use of an `as` cast must carry a short comment stating the invariant that
makes it safe. Casts to `any` (even via double-cast) fail review.

### Branded types for ids and money — DECISION: `Cents`

All money is **integer cents** (`Cents`) end-to-end. Display formatting to
dollars happens once, at render time, in the Angular layer (`formatCents`),
and rounding to the nearest $1,000 happens once, inside the engine
(`roundToNearestThousandCents`). No dollars anywhere in business logic.

```ts
// packages/contracts/src/branded.ts
declare const __brand: unique symbol;
export type Brand<T, B> = T & { readonly [__brand]: B };

export type Cents = Brand<number, 'Cents'>;
export const cents = (n: number): Cents => {
  if (!Number.isInteger(n)) throw new Error('Cents must be an integer');
  return n as Cents;
};

export type Uuid = Brand<string, 'Uuid'>;
export type CostDataVersion = Brand<string, 'CostDataVersion'>; // 'YYYY-MM-<city>-vN'
export type EstimateId = Brand<string, 'EstimateId'>;
export type MagicLinkToken = Brand<string, 'MagicLinkToken'>;   // URL-safe, 256-bit
```

```ts
// money.ts — the ONLY places conversions happen
import { z } from 'zod';
export const MoneyRangeCentsSchema = z.object({
  low: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
}).refine(r => r.low <= r.high, { message: 'low must be <= high' });
export type MoneyRangeCents = z.infer<typeof MoneyRangeCentsSchema>;
```

Why cents: Postgres stores money as `bigint` cents; cents kill float bugs
(`0.1 + 0.2`) and force a single display path. `formatCents` in web renders
`$729K` / `$729,000` per the display spec — never in contracts.

### Date/time handling

- DB: `timestamptz` everywhere (per SCHEMA.md). App code: **ISO-8601 UTC
  strings on the wire**, `Date` objects internally only when comparing.
- Never format dates in API code; never trust client-supplied "now".
- Display timezone is **America/Edmonton** (Calgary), taken from the `cities`
  row — never hard-coded per city. Angular: `DatePipe` with `'America/Edmonton'`
  / `Intl.DateTimeFormat` with `timeZone` from the city DTO.
- Engine rule: no `Date.now()` inside the engine. If an estimate needs an
  "as of" date it is an **input** (Section 4).

### zod owns every API boundary

`packages/contracts` is the single source of truth. Azure Functions handlers,
Angular forms/services, and the MCP server **import** schemas — they never
redefine a shape zod already describes.

```ts
// packages/contracts/src/api/estimate.schema.ts
import { z } from 'zod';

export const EstimateRequestSchema = z.object({
  project_type: z.enum(['new_build', 'renovation', 'comparison']),
  city: z.string().regex(/^[a-z-]+$/),           // 'calgary'
  sqft: z.number().int().min(200).max(20000),
  tier: z.enum(['standard', 'premium', 'luxury']).default('standard'),
  address_key: z.string().min(1).max(300).optional(),
  reno: z.object({
    type: z.enum(['extensive', 'addition', 'basement', 'combined']),
    underpinning: z.boolean().default(false),
  }).optional(),
  neighbourhoods: z.array(z.string().min(1).max(120)).min(2).max(3).optional(),
  idempotency_key: z.string().uuid().optional(),  // or Idempotency-Key header
});
export type EstimateRequest = z.infer<typeof EstimateRequestSchema>;
// handler: const parsed = EstimateRequestSchema.safeParse(body);
```

Function-level pattern (Azure Functions v4, TypeScript):

```ts
// apps/api/src/functions/estimates-post.ts
import { app, type HttpRequest, type InvocationContext } from '@azure/functions';
import { EstimateRequestSchema, toErrorEnvelope } from '@feasly/contracts';
import { estimateNewBuild } from '@feasly/cost-engine';

export async function estimatesPost(req: HttpRequest, ctx: InvocationContext) {
  const parsed = EstimateRequestSchema.safeParse(await req.json());
  if (!parsed.success) {
    return json(400, toErrorEnvelope('VALIDATION_ERROR', parsed.error, req));
  }
  // ... run engine, persist snapshot, return 201
}
```

`safeParse` failures map to `VALIDATION_ERROR` with the first human-readable
zod message (Section 3 catalog). `parse` (throwing) is never used at a
boundary.

---

## 3. API conventions

Base: `https://api.feasly.com/api/v1` (prod), `/api/v1` mounted on the Function
App. Everything below applies to the web BFF surface too (the Functions the
Angular app calls), except where noted "public API only" (M5).

### REST shape

- **Plural nouns, lowercase, kebab-case:** `POST /api/v1/estimates`,
  `GET /api/v1/estimates/{id}`, `GET /api/v1/properties?address=...`,
  `POST /api/v1/leads`, `GET /api/v1/reports/{token}`.
- **POST for actions** (nothing is a GET that mutates): `POST /api/v1/leads/{id}/resend-magic-link`,
  `POST /api/v1/reports/{token}/callback-requests`.
- JSON request/response, `Content-Type: application/json`.
- Success codes: `201` on create (with `Location` header), `200` otherwise,
  `202` for async (narrative generation queues behind estimate creation in M1+).
  `204` only for no-content deletes (none in V1).

### Versioning policy

- **URL version, additive-only within v1.** New optional fields, new endpoints,
  new enum values (declared in docs) are allowed in v1. Removing a field,
  renaming, changing a required field, or tightening a validation bound
  requires **v2** (`/api/v2/...`), running side-by-side; v1 deprecates with a
  `Sunset` header and a 12-month minimum notice to API-key holders.
- Contracts are versioned per major: `packages/contracts/src/v1/...`;
  a future v2 lives beside it. The engine's inputs are version-agnostic;
  adapters map `v1/v2` DTOs → engine inputs.

### Error envelope (mandatory)

```json
{ "error": { "code": "SNAKE_CASE", "message": "human-readable", "requestId": "…" } }
```

Starter code catalog (extend in `contracts`, never inline):

| code | HTTP | when |
|---|---|---|
| `VALIDATION_ERROR` | 400 | zod parse failure (message = first issue, humanized) |
| `ADDRESS_NOT_FOUND` | 404 | no City assessment match for address |
| `CITY_NOT_SUPPORTED` | 400 | city outside active set |
| `ESTIMATE_NOT_FOUND` | 404 | unknown estimate/report id |
| `LINK_EXPIRED` | 410 | magic link expired (multi-use bearer; 7-day window) |
| `LINK_INVALID` | 401 | malformed/unknown token — same timing, no existence oracle |
| `RATE_LIMITED` | 429 | over the key/IP budget |
| `IDEMPOTENCY_CONFLICT` | 409 | same key, different payload (replay mismatch) |
| `UPSTREAM_UNAVAILABLE` | 502 | City Socrata / Postmark / Meta API down |
| `UPSTREAM_TIMEOUT` | 504 | upstream timed out |
| `INTERNAL_ERROR` | 500 | unknown; message is generic, detail goes to logs only |

`toErrorEnvelope(code, detail, req)` in contracts builds it, stamping
`requestId` (below) and mapping zod errors to `VALIDATION_ERROR`. Messages are
user-safe by construction: never leak stack traces, SQL, param names, or
cost-model internals. `INTERNAL_ERROR`'s message is always
`"Something went wrong. Please try again."`.

### Pagination (cursor-based)

List endpoints (M4 admin leads, M5 usage) use opaque cursors, never offsets:

```
GET /api/v1/leads?limit=50&cursor=eyJpZCI6IjEyMyJ9
→ { "data": [...], "page": { "next_cursor": "…", "has_more": true } }
```

Cursor = base64url of `{ "id": "<last-seen-uuid>", "created_at": "<ts>" }`,
signed with the server secret (HMAC) so clients can't forge. `limit` default
50, max 200; `sort` fixed per endpoint (newest first), no arbitrary sort
params. Schema for the page envelope lives in contracts.

### Idempotency

- Endpoints that create side effects — `POST /api/v1/leads`,
  `POST /api/v1/reports/{token}/callback-requests`, M5 `POST /api/v1/leads`
  via API key, any Stripe-touching endpoint — accept **`Idempotency-Key`**
  (UUID v4) header, or `idempotency_key` in the JSON body (header wins).
- Behavior: same key + same payload hash within 24h → return the original
  response (`200`, with `Idempotent-Replayed: true` header). Same key +
  **different** payload → `409 IDEMPOTENCY_CONFLICT`.
- Storage: `idempotency_keys` table (`key_hash`, `payload_hash`,
  `response_status`, `response_body`, `created_at`); Function middleware
  handles it so handlers stay pure. Keys expire after 24h (TTL delete).

### Rate-limit headers

Every response carries:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 57
X-RateLimit-Reset: 1727059200
Retry-After: 42            # on 429 only
```

Web (session) budget: 60 req/min/IP on estimate endpoints; magic-link resend
additionally throttled (60s cooldown, Section UX_FLOW.md S7) with its own
narrower bucket. API-key budget: the key's `rate_limit` from `api_keys`
(default 100/min); headers reflect the tighter of key vs. global.

### Request-id propagation

- Middleware generates `requestId` (UUID v4) if the client didn't send
  `X-Request-Id`; echoes it as `X-Request-Id` on every response; includes it in
  the error envelope and in every structured log line for that invocation.
- Azure Functions: stash in `ctx.invocationContext` / `AsyncLocalStorage`
  wrapper (`@feasly/contracts` `withRequestId`) so the engine-adjacent code and
  DB layer can log it without threading it through pure functions.

### Auth

- **Web V1: magic-link only** (ADR-001). Session = HttpOnly, Secure,
  `SameSite=Lax` cookie `feasly_session` carrying an opaque session token
  (hash in DB, 30-day rolling expiry). The report token `/r/{token}` is a
  bearer magic-link token (256-bit, URL-safe, hashed at rest — `token_hash`
  per SCHEMA.md), **multi-use within its 7-day window** (NEEDS-KARAN confirms
  the window; default 7 days until he answers). Multi-use is deliberate:
  forwarding, partner shares, re-opens, and "Updated {date}" re-runs all
  assume a durable link (see USER_VALIDATION.md P0-C; embed relay codes stay
  strictly single-use — different table, different semantics).
- **Public API / MCP (M5): API keys.** `Authorization: Bearer feasly_live_...`
  (test: `feasly_test_...`) — only the SHA-256 hash stored (`key_hash`).
  — only the SHA-256 hash stored (`key_hash`). Scopes from `api_keys.scopes`:
  `estimate`, `lead`, `admin:read`. Middleware checks scope per endpoint;
  missing scope → `403` with code `FORBIDDEN` (add to catalog when M5 lands).
- Key prefix `feasly_sk_` lets support identify without the secret; rotation =
  create new + revoke old (no "view again" — secrets shown once at creation).
- No Basic auth, no query-string tokens (magic-link token travels in the URL
  path by design — it's a single-purpose bearer, logged redacted).

---

## 4. Deterministic-engine rules (hard)

`packages/cost-engine` is a **pure function**: `(inputs, costParams) -> outputs`.

### The law

```ts
// packages/cost-engine/src/index.ts
import type { EstimateInput, EstimateOutput, CostParams, EngineContext } from './types';

/** Pure. No I/O, no clock, no RNG, no LLM. Ever. */
export function estimate(input: EstimateInput, params: CostParams, ctx: EngineContext): EstimateOutput {
  // validate input invariants (throw EngineError on violation)
  // compute land/build/total ranges in Cents
  // round bands to nearest $1,000
  // return { rows, total, assumptions, cost_data_version: params.version, land_source }
}
```

1. **No I/O.** No `fetch`, no `fs`, no DB, no env reads. `CostParams` is passed
   in by the caller (Functions loads the frozen version from
   `cost_data_versions`; MCP loads it the same way; tests load fixtures).
2. **No `Date.now()`, no `Math.random()` inside.** Time and randomness are
   injected via `EngineContext`:
   ```ts
   export interface EngineContext {
     now: string;                    // ISO-8601, supplied by caller
     rng: () => number;              // seeded PRNG (mulberry32) in tests; real RNG in prod
   }
   ```
   `Math.random` is banned in the package via eslint `no-restricted-globals`
   override for `packages/cost-engine`.
3. **No LLM anywhere in the money path.** The engine's outputs feed the
   narrative prompt; the narrative never feeds back into numbers. The
   `assumptions` array is the *only* channel engine → narrative (COST_ENGINE.md).
4. **Versioned params in, pinned version out.** `CostParams.version` is
   `YYYY-MM-<city>-vN` (e.g. `2026-09-calgary-v1`, `2026-09-calgary-v2` after
   calibration). Every `EstimateOutput` carries `cost_data_version`; the
   Function persists it on the estimate row. A frozen version's params are
   never mutated — a correction is a new version.
5. **Units:** params express $/sqft as **decimal dollars in config** but the
   engine converts to integer `Cents` at the first arithmetic step and never
   floats again. All returned ranges are `MoneyRangeCents`.
6. **Money math has one home.** `fmtMoney`, `roundToNearestThousandCents`,
   band multiplication — all live in the engine package. App code never
   reimplements them.

### Where the engine may run

- **Azure Functions** (`apps/api`) — web + public API estimate endpoints.
- **MCP server** (`packages/mcp`) — wraps the same functions.
- **Tests** (vitest) — fixtures per version.

### Where it must NOT run

- **Never in the browser bundle.** `apps/web` must not depend on
  `@feasly/cost-engine`. Enforced by an eslint `no-restricted-imports` rule in
  `apps/web`: importing `@feasly/cost-engine` is an error. (Web needs only the
  response DTOs + `formatCents` display helper, which live in contracts/web.)
- Never inside the narrative-generation step. The LLM prompt builder takes
  `EstimateOutput` as *read-only input*; a test asserts the prompt template
  contains no arithmetic on money fields.

### Test requirements (ship with the package)

- **Pinned fixtures per `cost_data_version`:** `fixtures/2026-09-calgary-v1/`
  holds 3 known addresses × 3 tiers → exact expected ranges. CI fails if any
  output drifts without a version bump (`--frozen-fixtures` mode: the test
  reads `params.version` and fails if the fixture dir name doesn't match).
- **Property-based invariants** (fast-check):
  - `total.low <= total.high`; `total = land + build` componentwise
    (low = land.low + build.low, high = land.high + build.high);
  - monotonic in sqft: `sqft_a > sqft_b` ⇒ `total.low_a >= total.low_b`;
  - tier ordering: standard < premium < luxury for identical inputs;
  - all bands rounded to nearest $1,000 (i.e. `value % 100_000 === 0` in cents);
  - land band is exactly ±10% of basis; build band exactly ±8%.
- **Secret-leak test:** serialize a full API estimate response
  (`JSON.stringify`) and assert it does not contain `per_sqft`, `margin`,
  `build_tiers`, `land_model`, or any `cost_data_versions.build_tiers` key
  names; also assert no number in the response has sub-$1,000 precision on a
  money field (leaks calibration granularity).
- **Determinism test:** same `(input, params, ctx)` twice ⇒ deep-equal output;
  different `rng` seeds must not change outputs (RNG unused in money path).

---

## 5. Testing strategy

### Unit — vitest

- Runner: **vitest** (workspace root), `*.test.ts` colocated with source.
- Covers: `packages/cost-engine` (Section 4), `packages/contracts` (zod
  schemas: valid/invalid matrices, boundary values), pure utils (money
  formatting, address normalization, lead scoring).
- Config sketch:

```ts
// vitest.config.ts (root)
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/api/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      thresholds: {
        // cost-engine is the money path: near-total coverage is the bar
        'packages/cost-engine/src/**': { lines: 100, branches: 100, functions: 100 },
        global: { lines: 85, branches: 80 }
      }
    }
  }
});
```

- **Do not test:** AI narrative text (no snapshots of LLM output — see below);
  third-party SDK internals; framework behavior.

### E2E — Playwright

- **Playwright**, Chromium + WebKit (Safari matters for the magic-link email
  flow on iPhones), against the SWA preview environment per PR.
- Happy path: landing → address autocomplete → scope → details →
  analyzing → preview (blur asserted) → gate submit → magic-link click (via
  test mailbox hook, not a real inbox) → full report visible → tier what-if →
  PDF download.
- Key failure states: address not found; City API down (route intercepted to
  500); invalid email at gate; expired magic link; resend cooldown; dark
  Analyzing screen failure → falls back to S1-style error with Retry.
- Auth in tests: a test-only Function endpoint (disabled in prod by
  `FEASLY_TEST_HOOKS` env) that mints magic links without Postmark.
  Never test against real Postmark/Stripe in CI.
- Config sketch:

```ts
// apps/web/playwright.config.ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4280',
         trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } },
             { name: 'webkit', use: { browserName: 'webkit' } }],
});
```

### Engine contract tests

- One suite per frozen `cost_data_version`: loads the version's fixture dir,
  runs `estimate(input, params, ctx)`, deep-compares outputs.
- **CI rule: outputs may not drift without a version bump.** If a code change
  alters any fixture output and the version string didn't change, the suite
  fails with `FIXTURE DRIFT: bump cost_data_version (YYYY-MM-<city>-vN)`.
  New version ⇒ copy fixtures, update expectations deliberately, record the
  change in the version's `notes`.

### API integration tests

- **Azurite** (Functions storage emulator) + **containerized Postgres**
  (`postgres:16-alpine` via GitHub Actions `services:`) — real SQL, real
  migrations, no mocks at the DB layer.
- Upstream fakes behind interfaces: `CityDataClient` (Socrata),
  `MailClient` (Postmark), `NarrativeClient` (Meta API) — in-memory fakes in
  tests; the *interface* is what's stable, asserted by a compile-time check
  (fake implements the interface; missing method = type error).
- Idempotency middleware, rate limiting, and the error envelope are tested at
  the HTTP layer (supertest-style against the Functions host).

### What NOT to test

- **No snapshot-testing of AI narrative text.** LLM output is
  nondeterministic; instead test: (a) the prompt builder receives the engine
  output read-only, (b) the required disclaimer footer is appended verbatim,
  (c) banned-phrase lint on the prompt template (no "sold price", no
  accuracy-guarantee phrasing), (d) narrative persistence stores the text
  unchanged.
- No testing of Socrata/Postmark/Meta SDK internals; no E2E against prod data.

---

## 6. Angular conventions

### Component model

- **Standalone components only.** No `NgModule` for features; `app.config.ts`
  wires providers (`provideRouter`, `provideHttpClient`, `provideClientHydration`).
- **Signals + OnPush.** Component state via `signal()`/`computed()`; all
  components `changeDetection: ChangeDetectionStrategy.OnPush`. No manual
  `subscribe` in components — use `toSignal()` or the `async` pipe; every
  subscription must be accounted for (`takeUntilDestroyed()` if imperative).
- Feature folders: `apps/web/src/app/features/wizard/`,
  `features/report/`, `features/embed/` (iframe route), `features/dashboard/`
  (builder admin). Shared UI in `shared/ui/` (dumb, presentational, inputs as
  signals).

### Prerender-safe code (hard rule)

Build-time prerendering executes components on the server. **Never touch
`window`, `document`, `localStorage`, `navigator`, `matchMedia`, or
`IntersectionObserver` at module scope or in constructors.**

```ts
// WRONG — crashes prerender
export class ScopeStepComponent {
  private saved = localStorage.getItem('feasly-wizard'); // throws at build
}

// RIGHT — PLATFORM_ID guard + afterNextRender
import { PLATFORM_ID, afterNextRender, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export class ScopeStepComponent {
  private platformId = inject(PLATFORM_ID);
  constructor() {
    afterNextRender(() => {
      if (isPlatformBrowser(this.platformId)) {
        this.store.restore(localStorage.getItem('feasly-wizard'));
      }
    });
  }
}
```

- Wizard state persistence (UX_FLOW.md: localStorage on every change) runs
  **only** in `afterNextRender` and in event handlers — never during SSR.
- `document.title`/meta tags: set via `Title`/`Meta` services in route
  resolvers or `afterNextRender`, never by direct DOM writes in constructors.
- `afterRender` for repeated DOM reads (resize observers); `afterNextRender`
  for one-shot browser-only init. The embed iframe's postMessage bridge and
  ResizeObserver both live behind `isPlatformBrowser`.

### TransferState + resolvers

- Data needed at prerender (community cost pages, sample report) is fetched in
  **route resolvers** and cached via `TransferState`, so the client doesn't
  refetch:

```ts
// apps/web/src/app/features/communities/community.resolver.ts
export const communityResolver: ResolveFn<CommunityPage> = (route) => {
  const api = inject(ApiService);
  const transfer = inject(TransferState);
  const slug = route.paramMap.get('slug')!;
  const key = makeStateKey<CommunityPage>(`community-${slug}`);
  if (transfer.hasKey(key)) {
    const v = transfer.get(key, null as never);
    transfer.remove(key);
    return v;
  }
  return api.getCommunity(slug).pipe(
    tap(page => { if (isPlatformServer(inject(PLATFORM_ID))) transfer.set(key, page); })
  );
};
```

- The wizard estimate calls are **client-only** (they depend on user input);
  they must not run during prerender — guard the `/estimate/*` routes'
  data fetching with `isPlatformBrowser`.

### Lazy loading boundaries

- One lazy chunk per top-level route: `''` (landing), `'estimate'`
  (wizard shell — steps are children, one chunk), `'r/:token'` (report),
  `'embed'` (iframe app), `'dashboard'` (builder admin), community pages.
- `loadComponent`/`loadChildren` in route defs; nothing eager except
  `AppComponent` and core providers. Budget per chunk: warn at 250KB,
  error at 400KB (see budgets in `angular.json`).
- `packages/contracts` types are tree-shakeable — import types with
  `import type` so no runtime zod code ships unless actually used for
  client-side validation (gate form uses zod; keep it, it's small).

### Form patterns (wizard)

- **Reactive forms** (`FormGroup`/`FormControl`), validators composed from
  `contracts` zod schemas where the shape is shared (email at the gate uses
  the same `LeadGateSchema` the Function validates — single source).
- Wizard state machine: a `WizardStore` (signal-based service) holds
  `{ step, address, property, scope }`; each step component reads/writes the
  store; route guards prevent skipping (`canActivate: [wizardGuard]` checks
  store completeness for the step).
- Numeric inputs (sqft slider + text input): single `FormControl<number>`,
  clamped on blur; slider and input two-way bound to the same control —
  never two sources of truth.
- Autosave: `valueChanges.pipe(debounceTime(300))` → `localStorage`
  (browser-only), plus restore on `afterNextRender`.

### Blur-until-verified UI pattern

Blurred money regions (UX_FLOW.md S5) render **placeholder DTOs — real
figures are NEVER in the DOM pre-verification** (view-source safe; decided
USER_VALIDATION.md P0-I). The API returns `{blurred:true}` placeholders for
build/total until the magic link is verified:

```html
<div class="money-blur" aria-hidden="true">
  <span class="blurred-value">§§§§§§</span>
  <span class="lock">Available after email verification</span>
</div>
<!-- screen-reader / no-JS alternative -->
<span class="sr-only">Build and total ranges are available after email verification.</span>
```

- CSS: `filter: blur(12px); user-select: none;` on `.blurred-value`.
  The blur is honest — it obscures a placeholder, not a real number.
- `aria-hidden="true"` on the blurred container + a separate
  `.sr-only` text alternative (per UX_FLOW.md a11y rule).
- Never render actual figures in `aria-label`s, `title` attributes, or
  meta/OG tags pre-gate — scrapers read those.
- A Playwright assertion (`blurred-no-real-numbers`) ships with WEB-008:
  view-source of the preview page must contain no `$`-figure in money
  regions before verification.

---

## 7. Embed-loader conventions

`packages/embed-loader`: vanilla JS, **zero dependencies**, <5KB gzipped.
It runs on arbitrary builder websites — treat the host page as hostile.

### Defensive coding

```js
// packages/embed-loader/src/loader.js
(function () {
  'use strict';
  var NS = '__feasly_embed__';           // unique prefix for every global
  try {
    var w = window;                     // never assume host globals exist
    var d = w.document;
    if (!d || !('querySelector' in d)) return;   // ancient browser: no-op, no throw
    // find <div data-feasly-embed data-builder="elite-craft"> mounts
    var mounts = d.querySelectorAll('[data-feasly-embed]');
    for (var i = 0; i < mounts.length; i++) mount(mounts[i]);
  } catch (e) { /* never break the host page */ }
  function mount(el) {
    try {
      var iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox',
        'allow-scripts allow-same-origin allow-forms allow-popups');
      // NOTE: allow-same-origin is scoped to the iframe's own origin
      // (feasly.com), not the host. No allow-top-navigation.
      iframe.src = EMBED_ORIGIN + '/embed?builder=' + encodeURIComponent(el.getAttribute('data-builder') || '');
      iframe.style.border = '0'; iframe.style.width = '100%';
      el.appendChild(iframe);
      wireResize(iframe);
    } catch (e) { /* swallow */ }
  }
})();
```

- **try/catch everything**, including the top level. A loader exception must
  never break the builder's site.
- Unique prefix (`__feasly_embed__`) on any global; no prototype patching;
  no reliance on host libraries (jQuery/`$` may be anything).
- Feature-detect before use; degrade to a plain link (`<a href="https://feasly.com">`)
  when iframes or postMessage are unavailable.

### postMessage wrapper (strict origin allowlist)

```js
var ALLOWED_ORIGINS = ['https://feasly.com', 'https://www.feasly.com'];
// staging/dev origins injected at BUILD time via EMBED_ORIGIN replacement —
// never read from the host page or query params.

function onMessage(handler) {
  function listener(ev) {
    if (ALLOWED_ORIGINS.indexOf(ev.origin) === -1) return;   // hard reject
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || msg.ns !== 'feasly-embed-v1') return;        // namespace check
    handler(msg, ev);
  }
  if (w.addEventListener) w.addEventListener('message', listener, false);
}
```

- Message schema (types in `@feasly/contracts/embed`): `{ ns: 'feasly-embed-v1', type: 'resize'|'lead'|'ready', payload }`.
- The Angular `/embed` route posts messages **only** to the origin it was
  loaded from — never `'*'`. The loader never `eval()`s message payloads.

### Resize via ResizeObserver + postMessage

- Inside `/embed`: `ResizeObserver` on the app root → debounce 100ms →
  `parent.postMessage({ ns, type: 'resize', payload: { height } }, origin)`.
- Loader sets `iframe.style.height = px + 'px'`. Fallback: fixed
  `min-height` + internal scroll if ResizeObserver is missing.
- **No cookies set by the loader.** Auth inside the iframe uses the same
  magic-link flow; `SameSite=None; Secure` session cookie set by the
  feasly.com response, never by loader JS. No fingerprinting, no localStorage
  writes from the loader.

### Build

- Single IIFE bundle via esbuild (`packages/embed-loader/build.mjs`),
  output `dist/loader.js`. Versioned filename at deploy
  (`loader.v1.js` — cache-busted per major). `EMBED_ORIGIN` replaced at build
  time per environment (dev/staging/prod), never runtime-configurable from
  the host.

---

## 8. Naming

| Layer | Convention | Example |
|---|---|---|
| Files (all TS/JS) | kebab-case | `estimate-input.ts`, `magic-link.service.ts` |
| Angular selectors | `feasly-` prefix | `<feasly-address-step>`, `<feasly-money-blur>` |
| Angular services | `*.service.ts`, `providedIn: 'root'` unless scoped | `lead-gate.service.ts` |
| Azure Functions | verb-noun, file = route | `estimates-post.ts`, `leads-post.ts`, `reports-get.ts`, `magic-links-verify-post.ts` |
| Function App route names | match REST path | `estimates-post` → `POST /api/v1/estimates` |
| DB tables/columns | snake_case (SCHEMA.md) | `cost_data_versions`, `token_hash`, `sheets_synced_at` |
| TS interfaces/types | PascalCase | `EstimateInput`, `MoneyRangeCents` |
| zod schemas | `*Schema` suffix | `EstimateRequestSchema` |
| Constants | UPPER_SNAKE | `DEFAULT_MAGIC_LINK_TTL_DAYS` |
| Cost-data versions | `YYYY-MM-<city>-vN` | `2026-09-calgary-v1` |
| Stripe metadata keys | `feasly_` prefix, snake | `feasly_estimate_id`, `feasly_tenant_id`, `feasly_api_key_id` |
| Magic-link tokens | 256-bit, base64url, no padding | `xQ9_…` (43 chars); stored as SHA-256 `token_hash` |
| API keys | `feasly_sk_` + base64url(32B) | shown once; `key_hash` stored |
| Idempotency keys | UUID v4 | header `Idempotency-Key` |
| Bicep files/resources | kebab-case | `function-app.bicep`, `feasly-prod-func` |
| GitHub workflows | kebab-case | `ci.yml`, `deploy-prod.yml` |
| Migrations | `NNNNNNN_description.sql` timestamp prefix, forward-only | `202609230001_create_estimates.sql` |

Kebab-case files vs snake_case DB is intentional: TS-land is kebab,
SQL-land is snake, and the repository/DTO layer translates (a `toSnake`/
`toCamel` boundary helper in `apps/api`, tested).

---

## 9. Versioning

### API semver

- Major = URL version (`/api/v1`). Within v1: additive only (Section 3).
- Breaking change ⇒ new major, side-by-side deploy, `Sunset` header on v1,
  12-month notice to key holders. `packages/contracts/src/v1` frozen at that
  point; v2 developed beside it.

### Cost-data version lifecycle

`draft → frozen → superseded`. **Never mutate frozen.**

- `draft`: editable params row, usable in dev/staging only (API rejects
  `draft` versions in prod — middleware check).
- `frozen`: immutable; estimates pin it; fixtures exist per frozen version.
- `superseded`: replaced by a newer frozen version; still resolvable for
  historical estimates/audits; never served for new estimates.
- New version string on every param change: `YYYY-MM-<city>-vN` with N
  incrementing per city per month. Fixture dir + contract tests follow the
  version (Section 4/5). The version row's `notes` records *why* it changed
  (e.g. "calibrated from Elite Craft Q3 quotes").

### DB migrations (forward-only)

- Tool: **dbmate** (decided 2026-09-23; see TECH_PLAN.md §10). Plain-SQL
  migrations in `db/migrations/` at repo root.
- Never edit a merged migration. Fix forward with a new migration.
- dbmate has no down-migrations: local dev resets with a fresh database
  (`docker compose down -v`); prod rolls forward only.
- CI runs migrations against the containerized Postgres on every PR
  (migrate up → seed → run integration tests → migrate down → up again to
  prove idempotence of the chain).

---

## 10. Documentation expectations

- **README per package** (`packages/*/README.md`, `apps/*/README.md`):
  what it is, why it exists, how to run/test it, and what it must never do
  (e.g. cost-engine README restates the purity law; web README documents the
  prerender-safe rule). A README that doesn't say how to run the thing is
  incomplete.
- **ADR process:** future architecture decisions are numbered ADRs in
  `feasly/adr/` (`ADR-002-*.md`, …), following ADR-001's format
  (Context → Decision → Alternatives → Consequences). Anything that changes a
  "hard" rule in this document gets an ADR first; the doc is updated after
  approval.
- **JSDoc on all exported engine functions** (`@param`, `@returns`,
  `@throws`, and the units — cents vs dollars stated explicitly).
- **OpenAPI spec generated from zod schemas** for `/api/v1`:
  `@asteasolutions/zod-to-openapi` in `packages/contracts`; CI generates
  `openapi/v1.json` and fails if it drifts from the committed copy.
  Served at `/api/v1/openapi.json`; human docs page at `/developers`.
- Inline comments explain *why*, not *what*. A `// HACK` must link an issue.
- `plan/` docs (BUILD_PLAN, SCHEMA, COST_ENGINE, UX_FLOW, this file) are the
  standing spec — code that contradicts them is a bug in the code.

---

## 11. Assumptions log + open questions

### Assumptions (simpler option chosen; revisit via ADR if wrong)

1. **Money = integer `Cents` everywhere** (Section 2). Display formatting is
   web-only. Postgres stores `bigint` cents.
2. **No Turborepo/Nx at MVP** — `tsc -b` project references enforce build
   order. Revisit if the workspace grows past ~10 packages.
3. **dbmate** as the migration runner (plain-SQL, single binary).
   Fallback: node-pg-migrate. Decide at M0.
4. **vitest + Playwright** (not Jest/Cypress) — vitest for TS-native speed,
   Playwright for cross-browser magic-link flows.
5. **Magic-link expiry 7 days**, multi-use bearer within the window (UX_FLOW.md Q3 proposes
   7 days; Karan hasn't confirmed — 7 days is the default until he answers).
6. **`zod-to-openapi`** for spec generation (not hand-written YAML).
7. **Embed loader built with esbuild** as a single IIFE (not Rollup/webpack).
8. **No enums in TS** — string unions + const objects, mirroring DB CHECKs.
9. **`exactOptionalPropertyTypes: true`** is on — optional fields must be
   handled as `T | undefined`; use `.default()`/`.optional()` deliberately in
   zod so DTOs match.
10. **Session cookie 30-day rolling** for web; report bearer tokens separate
    from sessions (a forwarded link works — accepted M1 risk per UX_FLOW.md).
11. **Rate-limit defaults:** 60 req/min/IP (web estimate endpoints),
    100 req/min/API key (M5 default per SCHEMA.md). Tune from real traffic.
12. **Angular 18** (latest stable as of 2026-09; signals are stable API).
    Standalone-only is assumed settled (no NgModule migration debt).
13. **Meta API provider abstraction** per ADR-001; the concrete SDK client is
    chosen at M1 when narrative generation is wired.

### Open questions (need Karan or a future ADR)

- Q1 (→ Karan): magic-link expiry — 7 days OK? (UX_FLOW.md Q3)
- Q2 (→ Karan): name field at gate — required or optional? (UX_FLOW.md Q2)
- Q3 (→ Karan): renovation card in M1 — disabled + "Coming soon" badge, or
  selectable → waitlist? (UX_FLOW.md Q1)
- Q4 (→ Karan): sample report on landing — yes? (UX_FLOW.md Q4)
- Q5: API-key scopes final list for M5 (`estimate`, `lead`, `admin:read` —
    `admin:read` needs his call before M5).
- Q6: per-estimate metering/billing for M5 — flat key rate limits now, usage
    metering from day one (ADR-001); pricing model TBD.
- Q7: `allow-same-origin` on the embed iframe sandbox — needed for the
    session cookie inside the iframe; re-validate against the final auth
    design before M1 embed work, with a clickjacking assessment.
- Q8: lead dedupe rule (same email + address within 90 days → update vs new)
    — SCHEMA.md marks TBD with Karan (M4).
