# Rate limits — HRD-03 (2026-09-24)

Every per-caller limit on the platform: the route, the ceiling, the key, and
where it is enforced. All limits are fixed-window, in-memory per Functions
instance, and read from typed config (`apps/api/src/config.ts`) — no literal
in routes, services, or middleware (enforced by `test/boundaries.test.ts`).

Over-limit responses are RFC 7807 with `code: "RATE_LIMITED"`,
`retryAfterMs` in the body, and a `Retry-After` header in whole seconds
(ceil, minimum 1) — see `problemResponseHeaders` in
`apps/api/src/middleware/errors.ts`.

Rate-limit log lines carry a SHA-256 **hash** of the client IP
(`clientIpHash=…`), never the raw IP — see `hashClientIp` in
`apps/api/src/middleware/pipeline.ts`.

## Enforced today

| Route | Limit | Window | Key | Env overrides |
|---|---|---|---|---|
| `POST /api/v1/leads` | 10 requests | 60 s | client IP | `LEAD_RATE_LIMIT_MAX_REQUESTS`, `LEAD_RATE_LIMIT_WINDOW_MS` |
| `POST /api/v1/magic-link/reissue` | 1 email | 60 s | normalized email address | `MAGIC_LINK_REISSUE_COOLDOWN_MS` |
| `POST /api/v1/estimate` | 20 requests | 1 hr | client IP, plus per-tenant aggregation for embed traffic (`tenant:<tenantKey>` bucket, also 20/hr) | `ESTIMATE_RATE_LIMIT_MAX_REQUESTS`, `ESTIMATE_RATE_LIMIT_WINDOW_MS`, `ESTIMATE_TENANT_RATE_LIMIT_MAX_REQUESTS`, `ESTIMATE_TENANT_RATE_LIMIT_WINDOW_MS` |
| `GET /api/health` | 100 requests | 60 s | client IP | `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_MS` |

The limiter also bounds its in-memory key map (`RATE_LIMIT_MAX_TRACKED_KEYS`,
default 10 000) so a flood of distinct keys cannot exhaust memory; expired
windows are swept when the bound is exceeded.

## Reusable mechanism (for upcoming stories)

The throttler is `createRateLimiter` (`apps/api/src/middleware/rate-limit.ts`)
wired through `createRequestPipeline` (`apps/api/src/middleware/pipeline.ts`).
The pipeline accepts a `keyFor(request)` function — default is the client IP —
so a policy can aggregate per tenant as well as per IP, and an
`extraLimiters` list for independent secondary budgets (the estimates
endpoint enforces per-IP first, then a per-tenant bucket for embed traffic).
The lead and estimate adapters forward `tenantKey` from the request body
onto the pipeline request for this purpose. New rate-limited routes should
reuse this mechanism, not build their own.

## Planned (not yet enforced — endpoints or stories pending)

| Route | Planned limit | Notes |
|---|---|---|
| Partner share | 5 / min / IP | Endpoint does not exist yet (`POST /api/v1/shares` arrives with the partner-share story) |
| Callback request | TBD | `POST /api/v1/callbacks` does not exist yet |

## Endpoint-specific notes

### `POST /api/v1/magic-link/reissue` — per-email resend cooldown (HRD-03)

A repeat reissue while a live link exists already returns `{ sent: false }`
without sending — no duplicate emails. The per-email cooldown covers the
residual path (revoked/expired link, immediate re-request): at most **one
magic-link email per address per 60 s** (`MAGIC_LINK_REISSUE_COOLDOWN_MS`,
default `60_000`). Cooldown denials answer `{ sent: false }` — identical to
the live-link, unknown-email, and quarantined-lead outcomes — so the endpoint
can't be used as a send oracle. Tracked in-memory per Functions instance,
keyed by normalized email; same deliberate scale-out tradeoff as the request
rate limiters above.

## Scale-out note

Each Functions instance holds its own counters, so the effective global
ceiling is roughly instances × the configured max. Acceptable for V1
lead-gen traffic; a distributed (Redis) limiter is the hardening path if
abuse ever appears.
