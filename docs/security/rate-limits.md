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
| `POST /api/v1/estimate`, `GET /api/health` | 100 requests | 60 s | client IP | `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_MS` |

The limiter also bounds its in-memory key map (`RATE_LIMIT_MAX_TRACKED_KEYS`,
default 10 000) so a flood of distinct keys cannot exhaust memory; expired
windows are swept when the bound is exceeded.

## Reusable mechanism (for upcoming stories)

The throttler is `createRateLimiter` (`apps/api/src/middleware/rate-limit.ts`)
wired through `createRequestPipeline` (`apps/api/src/middleware/pipeline.ts`).
The pipeline accepts a `keyFor(request)` function — default is the client IP —
so a policy can aggregate per tenant as well as per IP (e.g.
`` `${ip}::${tenantKey}` `` for embed traffic). The lead adapter already
forwards `tenantKey` from the request body onto the pipeline request for
this purpose. New rate-limited routes should reuse this mechanism, not build
their own.

## Planned (not yet enforced — endpoints or stories pending)

| Route | Planned limit | Notes |
|---|---|---|
| `POST /api/v1/estimates` (consumer) | 20 / hour / IP, plus per-`tenant_id` aggregation for embed traffic | Estimates rate-limit story; reuses the pipeline `keyFor` seam |
| Magic-link request / resend | 60 s cooldown per email | Frontend enforces `timings.resendCooldownSec` today; backend enforcement lands with the magic-link endpoints |
| Partner share | 5 / min / IP | Endpoint does not exist yet (`POST /api/v1/shares` arrives with the partner-share story) |
| Callback request | TBD | `POST /api/v1/callbacks` does not exist yet |

## Scale-out note

Each Functions instance holds its own counters, so the effective global
ceiling is roughly instances × the configured max. Acceptable for V1
lead-gen traffic; a distributed (Redis) limiter is the hardening path if
abuse ever appears.
