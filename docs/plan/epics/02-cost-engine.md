# EPIC 02 — Cost Engine

**Owner:** TPM (implementation epics)
**Package:** `packages/cost-engine` + Azure Functions wrapper in `apps/api`
**Milestone coverage:** M1 (new build), M2 (renovation data model), M3 (comparison data model)

## Goal

Build a deterministic, pure-TypeScript, zero-I/O cost engine that computes
land/build/total MoneyRanges from server-side secret params. The engine must
be provably leak-free (no per_sqft/margins in serialized output), version-pinned
(`cost_data_version` lifecycle draft → frozen → superseded), and fully
test-covered with fixtures + property-based tests. Ship a thin Functions
endpoint (`POST /api/v1/estimate`) that loads params server-side and returns
ranges only, plus a Meta-API narrative prompt builder with banned-content
guards where `assumptions[]` is the only engine→LLM channel.

## Non-goals

- MCP server wrapper (EPIC — M5 epic, owns that).
- Google Sheets auto-sync (M4 admin epic owns it).
- City of Calgary Socrata fetch client (lives in `apps/api`, not this package;
  the engine receives `assessed_value`/`lot_sqft` as plain inputs — zero I/O rule).
- Narrative generation itself (engine only builds the prompt; the API calls Meta API).
- Accuracy tracking harness (M6).
- Per-estimate billing/metering (M5).

## Key decisions

1. **Pure function signature:** `estimate(input: EstimateInput, params: CostParams): EstimateOutput`. Params are injected, never imported from disk — keeps the package zero-I/O and testable without a DB.
2. **Money is integer cents end-to-end** (decided USER_VALIDATION.md P0-E:
  matches Stripe, SCHEMA.md bigint intent, and every billing story). Internal
  math in cents; rounding to the nearest $1,000 happens at output boundaries
  via a single `fmtMoney` pass; dollars exist only in display formatting.
  Branded `Cents` type per CODING_PATTERNS §2 — no floats anywhere in the
  money path.
3. **Range bands are parameters, not constants:** `land_band: {low: 0.90, high: 1.10}`, `build_band: {low: 0.92, high: 1.08}`, `reno_band: {low: 0.80, high: 1.25}` live in `cost_data_versions.reno`/`land` jsonb so calibration can tighten them without a code change.
4. **Tier ordering enforced in code:** engine validates `standard < premium < luxury` per_sqft at param load and throws `InvalidParamsError` otherwise — calibration mistakes fail loudly at freeze time, not silently in prod.
5. **Version lifecycle in the DB, enforced by seed script:** a version row starts `draft`; freeze script sets `frozen` and flips the previous frozen row to `superseded`; the engine refuses to run against `draft` in production (env flag `COST_ENGINE_ALLOW_DRAFT=false`).
6. **PDF decision deferred to EPIC 03** — engine only needs to supply rows/assumptions; PDF choice is a web concern.
7. **Reno/comparison ship in the data model + engine now (ENG-004)**, Formulas active but the API route stays gated behind a feature flag until M2/M3 UI exists — avoids rework while keeping M1 API surface minimal.
8. **Secret-leak testing is a CI gate, not advisory:** `vitest` test `no-secrets-in-output` scans `JSON.stringify(output)` against a deny-list (`per_sqft`, `margin`, `perSqft`, `cost_params`, `tiers`) and fails the build on any match.

---

## Stories (dependency order)

### ENG-001 — Package scaffold + build/test wiring
**Description:** Create `packages/cost-engine/` with `package.json` (ESM, TS strict, no runtime deps), `tsconfig.json` extending the monorepo root config, `vitest` config, and a `src/index.ts` barrel exporting the contract types (`EstimateInput`, `EstimateOutput`, `MoneyRange`, `CostParams`). Wire `build` (`tsc --noEmit` + bundle via `tsup` to `dist/`), `test` (`vitest run`), and `lint` scripts into the monorepo's turbo/pnpm workspace graph so CI builds it before `apps/api`.

**Acceptance criteria:**
- `pnpm --filter @feasly/cost-engine build` succeeds with zero TS errors under `strict` mode.
- `pnpm --filter @feasly/cost-engine test` runs (initially: 1 smoke test asserting the barrel exports `estimate`).
- No `node_modules` runtime dependencies beyond dev tooling (`vitest`, `tsup`, `typescript`); `npm ls --prod` shows empty.
- Root `pnpm-workspace.yaml` includes `packages/*`; `apps/api` can `import { estimate } from '@feasly/cost-engine'`.

**Dependencies:** M0 repo scaffold (exists per BUILD_PLAN M0 — ENG-001 assumes the monorepo root exists).
**Size:** S

### ENG-002 — New-build implementation per COST_ENGINE.md
**Description:** Implement `estimate()` for `project_type: 'new_build'`: land from assessed value ± land band (label `"Land (property acquisition — City-assessed basis)"`, `land_source: 'assessed'`) or fallback `lot_sqft × neighbourhood avg $/sqft` from params (`land_source: 'estimate'`); build = `sqft × tier.per_sqft` × build band; total = componentwise sums; round all bands to nearest $1,000 via `fmtMoney`; populate `rows[]` (Land, Build, Total), `total`, `assumptions[]` (e.g. `"Land from City-assessed value $729,000"` — verbatim restatable by the LLM), `cost_data_version` passthrough, `land_source` flag.

**Acceptance criteria:**
- Given assessed value $729,000, sqft 2,400, tier standard with per_sqft $300 (draft params): `land = {low: 656000, high: 802000}` (0.90/1.10 × 729,000, rounded to $1k); `build` uses the injected band; `total.low === land.low + build.low` and `total.high === land.high + build.high` exactly.
- `assumptions[]` contains a string with the assessed value in `$X` format; it is the only numeric claim passed to narrative (assert in test).
- Unknown tier string throws `InvalidInputError`; negative/zero sqft throws `InvalidInputError`; missing `address_key` AND missing `lot_sqft`/neighbourhood fallback params throws `InvalidInputError`.
- No per_sqft, margin, or param tables appear anywhere in the returned object (deep-scan test).

**Dependencies:** ENG-001
**Size:** M

### ENG-003 — Cost-data version lifecycle + seed script
**Description:** Implement the version lifecycle that the engine and DB share: a `scripts/freeze-cost-data.ts` (run via `pnpm --filter @feasly/cost-engine freeze`) that (a) validates a draft `cost_data_versions` row (tier ordering standard < premium < luxury, all bands sane, every reno type present), (b) marks it `frozen` with `effective_from = now()`, and (c) flips the prior frozen row for the city to `superseded`. Engine `estimate()` accepts `cost_data_version` string and refuses `draft` versions when `COST_ENGINE_ALLOW_DRAFT !== 'true'`. Seed script `scripts/seed-draft.ts` inserts an initial `draft` row for Calgary from a checked-in `data/calgary.draft.json` (placeholder params, clearly marked `// PLACEHOLDER — replaced by calibration`).

**Acceptance criteria:**
- Freezing a draft with `premium.per_sqft <= standard.per_sqft` fails with a named error and the row stays `draft`.
- After freeze, exactly one `frozen` row per city; prior frozen row is `superseded`; `effective_from` set.
- `estimate()` with a `draft` version and `COST_ENGINE_ALLOW_DRAFT` unset throws `DraftVersionError`.
- `data/calgary.draft.json` carries a top-level `"_warning": "PLACEHOLDER PARAMS — do not freeze without calibration"` field.

**Dependencies:** ENG-001; M0 Postgres provisioned (schema from SCHEMA.md applied).
**Size:** M

### ENG-004 — Renovation + comparison data model and formulas (M2/M3 scope, engine lands now)
**Description:** Implement `estimate()` branches for `project_type: 'renovation'` and `'comparison'` per COST_ENGINE.md so the data model and math land in M1 with zero rework later: reno types `extensive` (sqft × per_sqft[tier]), `addition` (min(sqft,400) × per_sqft[tier]), `basement` (sqft × per_sqft[tier] + optional underpinning flat range), `combined` (sum of components); reno band ±20–25% from params (wider existing-condition risk); comparison takes `neighbourhoods: [2–3]`, computes per-neighbourhood land = `avg_lot_sqft × avg_land_per_sqft` ±10% + tier build, marks `lowest_land: true` on the cheapest, returns one row-set per neighbourhood.

**Acceptance criteria:**
- Reno `extensive`, 1,000 sqft, tier premium at per_sqft $200 (draft params), band 0.80/1.25: range = {160000, 250000} pre-rounding, rounded to $1k.
- `addition` with sqft 600 caps billable area at 400 sqft (test asserts build.high with 600 input equals build.high with 400 input).
- `basement` with `underpinning: true` adds the `reno.underpinning.{low,high}` flat range componentwise to the basement range.
- Comparison with 2 neighbourhoods returns 2 row-sets; exactly one carries `lowest_land: true`; pre-gate visibility note: engine output includes a `visibility` hint per row (`'visible' | 'blurred'`) mapping land→visible, build/total→blurred (consumed by EPIC 03).
- Reno/comparison branches are inert for `new_build` inputs (no output shape change).

**Dependencies:** ENG-002, ENG-003
**Size:** M

### ENG-005 — Calibration import from Karan's cost Sheet + freeze `2026-XX-calgary-v1`
**Description:** **NEEDS-KARAN: the Google Sheet with 3–4 houses of historical cost data (share link / export).** Build `scripts/import-calibration.ts` that reads the sheet (CSV export URL), maps each house to `{ tier, sqft, actual_build_cost }`, computes implied per_sqft per tier (median per tier, documented method), writes a new `draft` `cost_data_versions` row for Calgary with calibrated `build_tiers` + land/reno params, prints a calibration report (per-house implied $/sqft, tier medians, outliers flagged >2σ), then runs `freeze-cost-data.ts` to produce `2026-XX-calgary-v1` (XX = current month). Karan reviews the calibration report before the freeze command is run — freeze is a NEEDS-KARAN approval gate.

**Acceptance criteria:**
- Import script accepts a CSV path/URL and a tier-mapping config (`data/tier-mapping.json`); unknown tier labels fail with a row-numbered error, never silently dropped.
- Calibration report written to `packages/cost-engine/calibration/REPORT-<version>.md` with per-house implied $/sqft, tier medians, sample size n, and an explicit caveat when n < 5 ("small sample — bands widened by +2pp pending more data").
- Frozen version string matches `^\d{4}-\d{2}-calgary-v\d+$`; prior draft rows untouched; `notes` field records sheet source + date + approver.
- Karan has approved the REPORT before freeze (approval recorded in the assumptions log / PR).

**Dependencies:** ENG-003; NEEDS-KARAN: cost Sheet shared.
**Size:** M
**NEEDS-KARAN:** Sheet share (data); approval of calibration report before freeze.

### ENG-006 — Pinned fixtures per version (CI drift gate)
**Description:** Add `test/fixtures/<version>.json`: 3 known Calgary addresses × 3 tiers → pinned expected ranges for the frozen version. A `vitest` suite `fixtures.test.ts` loads the frozen `cost_data_version` params and asserts byte-exact range equality. CI fails on any drift; the only way to make it pass is bumping the version (new frozen row + new fixture file). Document the "drift → bump" workflow in `packages/cost-engine/README.md`.

**Acceptance criteria:**
- Fixture file exists for `2026-XX-calgary-v1` with 9 pinned cases (3 addresses × 3 tiers), each with inputs, full expected `EstimateOutput`, and the `cost_data_version` string.
- Changing any param in the frozen row (simulated in test via param override) fails the suite with a diff pointing at the changed range.
- README documents: "If fixtures fail, do not edit the fixture — create a new version via freeze script and add a new fixture file."

**Dependencies:** ENG-005 (needs a frozen version to pin)
**Size:** S

### ENG-007 — Property-based tests (invariants)
**Description:** Add `test/properties.test.ts` using `fast-check` (dev dep): for arbitrary valid inputs across all three project types — (1) `total.low ≤ total.high`; (2) `total.low === land.low + build.low` and `total.high === land.high + build.high` componentwise (reno: sum of component rows); (3) monotonic in sqft (larger sqft ⇒ total.low/high non-decreasing, same tier/params); (4) tier ordering (standard ≤ premium ≤ luxury total ranges, same sqft/params); (5) all ranges rounded to nearest $1,000 in cents terms (`x % 100000 === 0` — cents; assertion comment names the dollar rule it implements).

**Acceptance criteria:**
- Suite runs ≥200 cases per property via fast-check; all pass against frozen v1 params.
- Monotonicity test holds tier and params fixed while varying sqft 800–6,000.
- Tier-ordering test holds sqft/params fixed while varying tier.
- Rounding property asserts every numeric leaf in `rows[]` and `total`.

**Dependencies:** ENG-002, ENG-004
**Size:** S

### ENG-008 — Secret-leak tests (serialized output scan)
**Description:** Add `test/no-secrets.test.ts`: serialize every `EstimateOutput` produced in the fixture + property suites via `JSON.stringify` and assert absence of a deny-list: `per_sqft`, `perSqft`, `margin`, `cost_params`, `build_tiers`, `land_params`, `reno_params`, and any key matching `/secret|internal/i`. Also assert the engine module has zero imports of DB/HTTP/fs modules (static check via a dependency allow-list test: allowed imports = `node:` builtins only, no `pg`, no `node-fetch`, no `fs`).

**Acceptance criteria:**
- Deny-list scan passes over all fixture outputs and 200 randomized outputs.
- Import allow-list test fails if anyone adds `fs`, `pg`, `node-fetch`, or similar to `src/`.
- Test file documents WHY each deny-listed term exists (one-line comment each).

**Dependencies:** ENG-002
**Size:** S

### ENG-009 — Functions wrapper: POST /api/v1/estimate
**Description:** In `apps/api`, add an Azure Functions HTTP trigger `POST /api/v1/estimate` that (a) validates the request body against the `EstimateInput` schema (zod), (b) loads the current `frozen` `cost_data_version` params for the city **server-side** (params never leave the function), (c) resolves land inputs (assessed value from the `properties` cache table or the Socrata fetch path owned by the API — engine receives plain numbers), (d) calls `estimate()` from `@feasly/cost-engine`, (e) persists the immutable snapshot to `estimates` (inputs/outputs/version id), and (f) returns `{ estimate_id, rows, total, assumptions, cost_data_version, land_source, visibility }` — ranges only. Rate-limit: 30 req/min/IP (Functions-level, configurable via app setting). Feature-flag `reno`/`comparison` project types behind `ENABLE_RENO_COMPARISON` (default false until M2/M3).

**Acceptance criteria:**
- Happy path returns HTTP 200 with ranges matching a direct engine call on identical inputs/params (contract test in `apps/api`).
- Response body deep-scanned: no deny-list terms from ENG-008 (shared scan helper imported from the engine package's test utils).
- Invalid body → 400 with field-level errors; unknown project_type → 400; reno/comparison with flag off → 400 `{error: 'not_enabled'}`.
- Every successful call writes exactly one `estimates` row with `cost_data_version_id` = frozen version; no UPDATE path exists in the handler.
- Params JSON never appears in function logs (log redaction test: assert `per_sqft` absent from captured logs).

**Dependencies:** ENG-002, ENG-004, ENG-006; M0 Function App + Postgres; Socrata/property lookup path in `apps/api` (owned by EPIC 03's S1 work or M0 — whichever lands first, this story consumes it as an interface).
**Size:** M

### ENG-010 — Narrative prompt builder (Meta API) with banned-content guards
**Description:** Add `src/narrative.ts` exporting `buildNarrativePrompt(output: EstimateOutput, facts: CityFacts): NarrativePrompt` where `CityFacts = { community, zoning, lot_sqft, year_built }` (from the City API, passed in — engine does no fetching). The builder composes a system prompt encoding: narrative may restate `assumptions[]` verbatim and use engine numbers only; output shape = 2–3 sentence executive summary + 3–5 risk factors + neighbourhood context; mandatory verbatim footer `"Dollar figures are calculated deterministically from our cost model — not generated by AI."`; banned list (sold prices, market-value claims, zoning/soil/utility assertions not in CityFacts, accuracy guarantees, PIPEDA/CASL compliance claims). Include a `validateNarrative(text, output)` guard that fails any narrative containing a `$`-figure not present in the engine output (regex-extract `$[\d,]+` tokens and compare against the engine's number set).

**Acceptance criteria:**
- Prompt contains the verbatim footer requirement and the full banned list; banned topics are phrased as explicit "do not" instructions, not soft guidance.
- `validateNarrative` passes a narrative restating only engine numbers; fails one containing `$850,000` when the engine returned `$729,000` (test with invented figure).
- `NarrativePrompt` type exposes `{ system, user }` strings; no API keys, no HTTP — the Functions app does the Meta API call (API-layer story, consumes this builder).
- Unit test asserts the builder never interpolates `CostParams` (only `EstimateOutput` + `CityFacts` are inputs — type-level guarantee).

**Dependencies:** ENG-002
**Size:** S

---

## Assumptions log

1. Monorepo root (`pnpm` workspaces + turbo or npm workspaces) exists from M0; ENG-001 only wires the package in.
2. Postgres with the SCHEMA.md tables (`cost_data_versions`, `estimates`, `properties`, `cities`) is provisioned in M0; seed/freeze scripts connect via `DATABASE_URL` app setting.
3. Karan's Sheet will have per-house: address or identifier, living-area sqft, finish tier label, actual total build cost (excl. land). If the sheet's columns differ, `data/tier-mapping.json` + a column-map config absorb it — logged as a calibration-report footnote, not a blocker.
4. Draft params in `data/calgary.draft.json` are placeholders; nothing ships to prod on placeholders (ENG-003 `DraftVersionError` + ENG-005 freeze gate enforce this).
5. The API owns Socrata fetching and the `properties` cache; the engine receives `assessed_value: number` / `lot_sqft: number` as plain inputs (zero-I/O boundary).
6. Meta API provider abstraction lives in `apps/api` (M1 API work); this epic only builds the prompt + validator.

## Open questions

- **Q-ENG-1:** Should `fmtMoney` rounding be nearest-$1k for ALL ranges including small reno line items (e.g. a $4,200 underpinning add-on rounds to $4,000)? Current call: yes, uniform $1k — confirm with Karan if reno small-ticket items need $100 granularity. (Simpler option chosen: uniform $1k; logged.)
- **Q-ENG-2:** Calibration with n=3–4 houses is thin — widen bands automatically (+2pp) or keep spec bands and flag in report? Current call: keep spec bands, flag small-sample caveat in calibration report; revisit after ≥10 builder quotes (M6 loop).
- **Q-ENG-3:** Does the `visibility` hint (`visible`/`blurred` per row) belong in the engine output or the API layer? Current call: engine emits it (single source of truth for the visibility rule); API passes through.
- **Q-ENG-4 (NEEDS-KARAN):** Confirm tier labels in the Sheet map to Standard/Premium/Luxury, or provide the mapping — needed before ENG-005.
- **Q-ENG-5:** Garage/basement options from S3 (None/Double/Triple, Unfinished/Finished) — are these cost adders in v1 params or v2? Current call: v1 ignores them in math but records them in `inputs` (audit trail); adders come with calibration v2. Logged as a known v1 limitation.
