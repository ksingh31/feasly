# Epic 01 — Property Data

## Goal
Give the wizard a trustworthy, fast, always-available property lookup: a
server-side proxy in front of the City of Calgary's Current Year Property
Assessments dataset (Socrata `4bsw-nn7w`) exposing two endpoints — address
autocomplete (every suggestion guaranteed resolvable) and assessment lookup —
with normalized address keys, a Postgres cache, full failure-state handling
per UX_FLOW S1, rate limiting, and observability. Exit: the S1 address step
can be built entirely on these endpoints, including every error path, and a
seeded set of known-good addresses makes the whole flow demoable and testable.

## Non-goals
- The Angular UI itself (later epic consumes these endpoints).
- Cost math (cost-engine epic); lead gate / magic links (auth epic).
- Sold-price or MLS data (deferred per ADR — assessed value only, labeled
  honestly).
- Multi-city support (schema is ready; only Calgary is wired).

## Key decisions
- **Server-side proxy, not direct browser calls** (decided in PRD-001):
  the browser never talks to Socrata. Rationale: (1) the Socrata app token
  stays server-side in Key Vault; (2) we can cache aggressively and cut
  latency + City API load; (3) rate limiting and abuse protection live in
  one place; (4) we control the response contract — raw Socrata field names
  and internals never leak to the client and we survive upstream schema
  drift; (5) structured logging/metrics on every lookup; (6) PII-adjacent
  query logging stays under our retention policy, not the browser's.
- Endpoint paths (versioned from day one; these become the M5 agent API's
  `get_property` surface): `GET /api/v1/properties/autocomplete?q=...` and
  `GET /api/v1/properties/resolve?address_key=...` (resolve = exact lookup;
  the agent-API `get_property` in M5 wraps the same handler).
- Cache policy: `properties` table is the cache; TTL 30 days per
  `fetched_at` (assessments update annually — 30 days is conservative and
  cheap; logged assumption). Stale rows are never served silently: either
  refreshed or flagged.
- Address normalization is deterministic and documented (PRD-003); the
  `address_key` is the cache/dedupe key and the only address form the API
  accepts for resolve.

---

## Stories (dependency order)

### PRD-001 — Socrata proxy design spike (justify server-side vs direct browser)
**Description:** Time-boxed design spike confirming the proxy architecture:
verify the `4bsw-nn7w` Socrata endpoint's live fields, query options
(`$q`, `$where`, `$limit`), rate limits with and without an app token, and
CORS behavior for browser-direct calls. Output is a decision record
justifying the server-side proxy (per Key decisions above) plus the concrete
Socrata query strategy (which endpoint flavor, `$select` field list,
token usage). Read-only research — no account creation; a Socrata app token
can be self-registered by the developer later without Karan.

**Acceptance criteria:**
- `docs/socrata-proxy-decision.md`: confirmed live field names for assessed
  value, neighbourhood/community, land-use/zoning designation, lot size,
  year built, geometry; query strategy (`$q` for autocomplete,
  `$where` on normalized address for resolve); measured p50/p95 latency from
  the Azure region; rate-limit behavior with/without app token.
- Decision matrix: server-side proxy vs direct browser calls scored on
  secret handling, caching, rate limiting, contract stability, observability
  — proxy wins with written rationale for each axis.
- Open risk noted: upstream field renames — mitigation is the
  field-mapping layer in PRD-004, not client code.

**Dependencies:** none
**Size:** S

---

### PRD-002 — Address autocomplete endpoint
**Description:** Build `GET /api/v1/properties/autocomplete?q=...` in
`apps/api`: requires ≥3 characters (400 otherwise), queries Socrata `$q`
with `$limit=6`, maps results to `{ address_key, display_address,
neighbourhood }`, and enforces the UX_FLOW S1 contract — **max 6
suggestions, every suggestion guaranteed resolvable** (each returned
`address_key` must succeed on the resolve endpoint; suggestions that fail a
resolve check are filtered before responding).

**Acceptance criteria:**
- Contract schema in `packages/contracts/schemas/autocomplete.json`
  (request/response, draft 2020-12); endpoint validates `q` (min 3 chars,
  max 100, trimmed; 400 on violation).
- Response: max 6 items, each with `address_key`, `display_address`
  (human-readable, e.g. "1234 5 Ave NW"), `neighbourhood`; empty array (200,
  not 404) when nothing matches.
- Resolvability guarantee: integration test asserts every returned suggestion
  resolves via PRD-003's handler; a suggestion that cannot be resolved is
  dropped, never returned.
- Debounce contract documented for the client: 250 ms, cancel in-flight on
  new keystroke (server is stateless per request — no session needed).
- Vitest unit tests for query building/escaping; contract test validates the
  response against the JSON schema.

**Dependencies:** PRD-001
**Size:** M

---

### PRD-003 — Assessment resolve endpoint + address_key normalization
**Description:** Build `GET /api/v1/properties/resolve?address_key=...`:
normalize the input, check the `properties` cache (`city_id` + `address_key`,
TTL 30 days), on miss query Socrata, persist the raw assessment JSON, and
return the mapped property (mapping itself is PRD-004). Document the
normalization rules in `docs/address-normalization.md` — this is the
dedupe key for estimates and leads, so it must be exact and stable.

**Acceptance criteria:**
- Normalization rules (documented + unit-tested): uppercase; trim;
  collapse internal whitespace; strip periods/commas; normalize directionals
  (`N.W.`, `N-W`, `N W` → `NW`); expand street-type suffixes per a fixed map
  (`ST`→`STREET`, `AVE`→`AVENUE`, `BLVD`→`BOULEVARD`, `DR`→`DRIVE`,
  `CRES`→`CRESCENT`, `PL`→`PLACE`, `RD`→`ROAD`, `TR`→`TRAIL`, `WAY`→`WAY`,
  `LN`→`LANE`, `CT`→`COURT`); unit/suite designators stripped to a separate
  `unit` field (never part of `address_key` — units trigger PRD-008).
- Cache behavior: hit + fresh → serve from DB (Socrata not called);
  hit + stale (>30d) → background refresh attempt, serve stale flagged
  `stale: true` only if refresh fails (PRD-007 policy); miss → Socrata →
  insert.
- `address_key` unique per `city_id`; concurrent double-miss inserts are
  safe (`ON CONFLICT DO NOTHING` + re-read).
- Integration test: resolve → cache hit on second call (Socrata called once,
  asserted via request counter).

**Dependencies:** PRD-001
**Size:** M

---

### PRD-004 — Response mapping (never expose raw Socrata internals)
**Description:** Implement the field-mapping layer between the raw Socrata
row and the API response: `assessed_value` (dollars, integer),
`neighbourhood`/`community` name, `land_use` (zoning designation code +
  human label), `lot_size_sqft`, `year_built`, and `lot_polygon` (GeoJSON,
  simplified). The mapping is the single place that knows Socrata's field
  names; the client only ever sees the stable Feasly contract. Raw Socrata
  payloads stay in `properties.assessment` jsonb and never leave the server.

**Acceptance criteria:**
- `packages/contracts/schemas/property.json` defines the public shape;
  secret-leak-style test asserts the serialized response contains none of
  the raw Socrata column names (denylist test, fails CI on leak).
- `assessed_value` labeled in API docs as "City-assessed value (not market
  value)"; `null` fields are explicit (`year_built: null` when missing, not
  omitted) so the client can render "not available".
- `lot_polygon`: simplified GeoJSON (tolerance documented, e.g.
  Douglas-Peucker 1 m) with a max-size guard (drop polygon, keep bbox, if
  >64 KB — logged in response as `polygon_simplified: true`).
- Unit tests pin the mapping for 3 fixture rows, including a row with
  missing optional fields.

**Dependencies:** PRD-003
**Size:** S

---

### PRD-005 — Failure state: address not found
**Description:** Implement the "not found" path end-to-end: when Socrata
returns zero rows for a normalized `address_key`, the resolve endpoint
returns a structured 404 (`code: "ADDRESS_NOT_FOUND"`) and the client copy
per UX_FLOW S1 — "We couldn't find that address. Check the spelling or try
a nearby address." Log the miss (normalized key only, no PII beyond the
address itself) for the failure-breakdown metric in PRD-010.

**Acceptance criteria:**
- 404 body: `{ code: "ADDRESS_NOT_FOUND", message: "<UX copy>", retryable: false }`
  validated against `packages/contracts/schemas/error.json`.
- Not cached as a negative result for longer than 24 h (avoid poisoning the
  cache if the City dataset updates; negative-cache TTL documented).
- Misses increment the `lookup.miss` metric with reason `not_found`.

**Dependencies:** PRD-002, PRD-004
**Size:** S

---

### PRD-006 — Failure state: non-Calgary address (waitlist capture deferred to Phase 2)
**Description:** Detect out-of-coverage addresses (Socrata query scoped to
the Calgary dataset returns nothing AND the input matches a non-Calgary
postal pattern or explicit city mention) and return
`code: "OUT_OF_COVERAGE"`. **M1 ships the message only** — UX copy:
"Feasly currently covers Calgary only — join the waitlist for your city."
— per UX_FLOW.md, which marks waitlist email capture as future. The
`POST /api/v1/waitlist` endpoint + `waitlist` table migration are deferred
to a Phase 2 growth story (also avoids collecting PII before the privacy
review in epic 09). When Phase 2 lands: `{ email, city }` capture with
validated email, CASL-unchecked-marketing default (waitlist email is
transactional interest; marketing opt-in separate and explicit).

**Acceptance criteria:**
- Detection heuristic documented in `docs/coverage-detection.md`: Socrata
  miss + (postal code not matching `T2`/`T3` Calgary prefixes OR explicit
  non-Calgary city token) → `OUT_OF_COVERAGE`; plain miss with Calgary
  signals → `ADDRESS_NOT_FOUND` (PRD-005). Heuristic is conservative:
  ambiguous cases return `ADDRESS_NOT_FOUND`.
- M1: `OUT_OF_COVERAGE` returns the waitlist-teaser copy; no email is
  collected and no `waitlist` table exists yet.
- Phase 2 (deferred story): `POST /api/v1/waitlist` — 201 on valid
  email+city, 409 on duplicate (same email+city), 400 on invalid email;
  rate-limited (PRD-009 applies); migration creates
  `waitlist(id, email citext, city text, created_at, UNIQUE(email, city))`.
- Contract tests cover the M1 error shape.

**Dependencies:** PRD-005
**Size:** M

---

### PRD-007 — Failure state: City API down/timeout — retry, circuit breaker, stale-cache fallback
**Description:** Harden the proxy against Socrata outages: per-request
timeout (5 s) + one retry with backoff for idempotent GETs; a circuit
breaker (5 consecutive failures → open for 2 minutes, half-open probe after);
when the breaker is open, serve stale cache rows flagged `stale: true`
(never invent data); when no cache exists, return 503
`code: "CITY_API_UNAVAILABLE"` with the UX copy "City property data is
temporarily unavailable. Try again in a few minutes." plus a `Retry-After`
hint. Breaker state transitions are logged and metered.

**Acceptance criteria:**
- Timeout 5 s, exactly 1 retry with 500 ms backoff; retry only on
  timeout/5xx, never on 4xx.
- Circuit breaker: opens after 5 consecutive Socrata failures, half-opens
  after 120 s with a single probe request; state exposed on
  `GET /api/v1/health` (`socrata: ok|degraded|down`).
- Stale-cache fallback: breaker open + stale row exists → 200 with
  `stale: true` and `fetched_at`; no row → 503 with `retryable: true`.
- Tests: simulated Socrata outage (mock transport) asserts breaker opens,
  stale row served, then recovery on probe success.
- Policy documented in `docs/city-api-resilience.md` (timeouts, retry,
  breaker thresholds, stale-serve rules).

**Dependencies:** PRD-003, PRD-004
**Size:** M

---

### PRD-008 — Failure state: multi-unit/condo detection
**Description:** Detect unitized addresses (suite/unit/apt designators in the
input, or Socrata rows flagged as condo/multi-unit via assessment class /
  land-use) and return 422 `code: "MULTI_UNIT_UNSUPPORTED"` with UX copy
  "Feasly currently supports single-family homes and lots." Detection runs
  before Socrata where possible (input parsing) to save the upstream call.

**Acceptance criteria:**
- Input-side detection: regex/unit-keyword list (`unit`, `suite`, `#`, `apt`,
  `-` sub-address patterns like `101-1234`) documented in
  `docs/address-normalization.md` alongside PRD-003; matched inputs short-
  circuit to 422 without a Socrata call.
- Data-side detection: mapping flags rows whose land-use/assessment class
  indicates condo/multi-unit (exact codes documented after PRD-001 field
  verification; assumption logged if codes are ambiguous).
- 422 body: `{ code: "MULTI_UNIT_UNSUPPORTED", message: "<UX copy>",
  retryable: false }`; increments failure-breakdown metric with reason
  `multi_unit`.

**Dependencies:** PRD-003, PRD-004
**Size:** S

---

### PRD-009 — Rate limiting on the proxy
**Description:** Protect the Socrata app-token quota and the Functions bill:
per-IP sliding-window rate limits on both property endpoints (autocomplete:
  30 req/min; resolve: 60 req/min — tuned for the 250 ms debounce contract),
  stricter on `/waitlist` (5 req/min/IP), with 429 + `Retry-After` and a
  documented header (`X-RateLimit-Remaining`). Limits are config, not code,
  and the M5 API-key limits build on the same middleware later.

**Acceptance criteria:**
- Middleware in `apps/api` (in-memory sliding window for M1; note the
  multi-instance limitation and the Redis/Distributed-cache upgrade path in
  code comments — logged assumption).
- 429 response shape matches `error.json` (`code: "RATE_LIMITED"`,
  `retryable: true`) with `Retry-After` seconds header.
- Limits configurable via env/Key Vault (`RATE_LIMIT_AUTOCOMPLETE`,
  `RATE_LIMIT_RESOLVE`, `RATE_LIMIT_WAITLIST`); tests assert 429 at n+1.
- Rate-limit hits logged with IP hash (not raw IP) for the metrics story.

**Dependencies:** PRD-002, PRD-003, PRD-006
**Size:** S

---

### PRD-010 — Logging & metrics: latency, hit rate, failure breakdown
**Description:** Emit structured logs and Application Insights custom metrics
for every property lookup: `lookup.latency_ms` (p50/p95 by endpoint),
`lookup.cache_hit` ratio, and `lookup.failure` broken down by reason
(`not_found`, `out_of_coverage`, `multi_unit`, `city_api_error`,
`rate_limited`, `timeout`). Add an App Insights workbook/dashboard definition
in repo (`infra/bicep` or `docs/`) so the numbers are one click away, and
alert rules for sustained Socrata outage (breaker open >10 min) — alert
target TBD (Karan's email; confirm in the question below).

**Acceptance criteria:**
- Every request to the two property endpoints logs: normalized
  `address_key`, endpoint, cache hit/miss/stale, latency ms, outcome code
  (no raw user input beyond the normalized key; no emails).
- Custom metrics: `feasly.lookup.latency`, `feasly.lookup.cache_hit`,
  `feasly.lookup.failure{reason}` queryable in App Insights.
- `docs/property-data-dashboard.md` documents the dashboard queries
  (KQL snippets) for latency p95, hit rate, and failure breakdown.
- Alert rule drafted (Bicep or documented click-ops): breaker open >10 min
  → notify; delivery target confirmed with Karan.

**Dependencies:** PRD-002, PRD-003, PRD-007
**Size:** S

---

### PRD-011 — SPIKE: permit-dataset field verification (attribution cross-check)
**Description:** Read-only research spike: determine whether Calgary's open
building-permit dataset exposes **applicant/builder name** and **address**
fields usable for the future Model A attribution cross-check (permit address
+ applicant name vs lead pipeline). No external actions, no account creation,
no data downloads beyond sample rows. Output is a findings doc with exact
field names, coverage notes, and a go/no-go for the attribution design.

**Acceptance criteria:**
- `docs/permit-dataset-fields.md`: dataset name/ID, exact field names for
  applicant/builder identity and address, sample (redacted) values, update
  cadence, license terms for commercial use, and gaps (e.g. applicant is a
  homeowner vs contractor, missing postal codes).
- Verdict: `feasible` / `partial` / `not-feasible` for the permit-data
  cross-check, with reasoning; if partial, what supplementation is needed.
- Time-box: 1 day; findings feed the later attribution epic, no code in
  this story.

**Dependencies:** none (independent research)
**Size:** S

---

### PRD-012 — Seed script: known-good test addresses
**Description:** Provide `infra/db/seeds/seed-test-addresses.ts` (npm script
`db:seed:test-addresses`) that resolves a curated list of ~10 real Calgary
addresses (covering: standard infill lot, new community, inner-city,
one known condo building for the multi-unit path, one fictional-but-
plausible address for the not-found path) through the resolve endpoint and
caches them in `properties`. Used by automated tests, demos, and the M1
wizard's "try a sample address" affordance.

**Acceptance criteria:**
- Seed list in `infra/db/seeds/test-addresses.json`: ≥10 entries with
  `address_key`, expected `neighbourhood`, and expected outcome
  (`ok` | `multi_unit` | `not_found`); each entry has a comment on why it
  was chosen.
- Script is idempotent and safe to run against dev/staging (never prod
  without Karan approval — guarded by an env check).
- CI smoke test: resolve all `ok` entries, assert 200 + mapped fields
  present; assert the condo entry returns 422 and the fictional entry 404.
- README note: addresses are public records (City open data); no PII concern.

**Dependencies:** PRD-003, PRD-004, PRD-008
**Size:** S

---

## Assumptions log
1. **Cache TTL 30 days** on `properties.fetched_at`: assessments update
   annually, so 30 days is conservative; stale rows are only served during
   outages and always flagged.
2. **Socrata app token**: developer self-registers (no Karan action needed);
   stored in Key Vault per FND-010; unauthenticated fallback works but at
   lower quota — token is the default path.
3. Rate limiting is **in-memory sliding window** for M1 (single-region
   Functions at MVP scale); multi-instance correctness gets a distributed
   store when M5 API keys land.
4. Street-suffix expansion map (PRD-003) covers Calgary's common types; if
   Socrata's canonical form differs for an edge case, the miss is logged and
   the map extended — normalization is versioned in docs, not silent.
5. `OUT_OF_COVERAGE` detection is heuristic and conservative by design;
   ambiguous inputs fall back to `ADDRESS_NOT_FOUND` rather than risk a
   wrong waitlist prompt.
6. Polygon simplification tolerance 1 m / 64 KB cap (PRD-004) — tuned for
   map rendering, not surveying; documented as display-only geometry.
7. Alert delivery target for the Socrata-outage alert defaults to Karan's
   email — confirm in open questions.

## Open questions
- **NEEDS-KARAN:** Socrata-outage alert (>10 min breaker open) — deliver to
  your email? Any secondary channel?
- Waitlist capture (PRD-006) — decided 2026-09-23: message only in M1, no
  email capture; capture deferred to a later growth phase (not an open
  question anymore).
- Condo/multi-unit Socrata codes: PRD-001 will confirm exact land-use /
  assessment-class codes — if ambiguous, do we ship input-regex detection
  only and treat data-side detection as best-effort? (Recommendation: yes —
  input detection catches the real user path; data-side is defense in depth.)
- Should autocomplete also match on neighbourhood names ("bridgeland 123…")?
  (Recommendation: no for M1 — address-prefix only; revisit if UX testing
  shows users typing community names.)
- Negative-cache TTL of 24 h for not-found (PRD-005): acceptable, or prefer
  no negative caching at all? (Recommendation: 24 h — protects the quota
  against typo-loops without risking stale misses after dataset updates.)
