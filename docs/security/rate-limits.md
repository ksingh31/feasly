# Rate limits — HRD-03 (2026-09-24), updated for #729 (2026-11-15)

Every per-caller limit on the platform. The per-route table at the bottom is
**generated** from `apps/api/src/registry/route-registry.ts` — don't edit it by
hand. `test/route-registry.conformance.test.ts` fails CI when the table and
the registry differ. To regenerate it, run (from `apps/api`):

```bash
npx tsx tools/insert-rate-limit-table.mts
```

All limits are fixed-window and read from typed config
(`apps/api/src/config.ts`). Routes, services and middleware contain no
literal limits (enforced by `test/boundaries.test.ts`).

Over-limit responses are RFC 7807 with `code: "RATE_LIMITED"`,
`retryAfterMs` in the body, and a `Retry-After` header in whole seconds
(ceil, minimum 1). See `problemResponseHeaders` in
`apps/api/src/middleware/errors.ts`.

Rate-limit log lines carry a SHA-256 **hash** of the client IP
(`clientIpHash=…`), never the raw IP. See `hashClientIp` in
`apps/api/src/middleware/pipeline.ts`.

## Client IP — how "per IP" is keyed (#729)

`X-Forwarded-For` is a comma-separated chain. Each hop **appends** the address
it received the connection from. The caller can pre-fill the header with
anything, so the left-most entries are spoofable. The Azure Functions front
end appends the real peer address on the right.

Every adapter resolves the client IP through one helper,
`clientIpFromHeaders` (`apps/api/src/middleware/client-ip.ts`). It:

- takes the **right-most** entry (the platform-appended hop);
- strips any port;
- returns `undefined` when that entry isn't a valid IP. Those requests share
  the conservative `unknown` bucket.

No function adapter parses the header itself. `test/boundaries.test.ts`
enforces this.

Topology assumption: the web app calls the Function App directly,
cross-origin, with no other proxy in front. If Front Door, APIM or an SWA
linked backend is ever added, its address becomes the right-most hop. The
helper must then skip that trusted hop. Revisit #729 before adding a proxy.

## Where counters live

| Limiter | Store | Scope key |
|---|---|---|
| `POST /api/v1/leads`: per IP | **Postgres, shared across instances** | `lead:ip` |
| `POST /api/v1/estimate`: per IP | **Postgres, shared across instances** | `estimate:ip` |
| `POST /api/v1/estimate`: per tenant (embed traffic) | **Postgres, shared across instances** | `estimate:tenant` |
| `POST /api/v1/magic-link/reissue`: per-email cooldown | **Postgres, shared across instances** | `magic-link:cooldown` |
| `POST /api/v1/magic-link/reissue`: per-email hourly send budget | **Postgres, shared across instances** | `magic-link:send` |
| Every other limiter | In-memory, per Functions instance | n/a |

**Shared counters** (`createSharedRateLimiter` / `createSharedCooldown` in
`apps/api/src/middleware/shared-rate-limit.ts`, store in
`apps/api/src/services/rate-limit.store.ts`, table `rate_limit_counters`):

- Every hit is one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so
  concurrent instances get exact counts.
- Windows are aligned to the epoch, so every instance agrees on the window.
- Keys are stored as `<scope>:<sha256>`. No raw IP or email address is
  persisted.
- Each instance deletes expired rows at most once per
  `RATE_LIMIT_SHARED_SWEEP_INTERVAL_MS` (default 5 min).
- If the database errors, each shared limiter falls back to its per-instance
  in-memory limiter (the pre-#729 behavior). A database blip never blocks or
  un-limits traffic.

No new Azure resource: this uses the existing Postgres server. A paid Redis is
explicitly out of scope.

**In-memory counters** (`createRateLimiter`,
`apps/api/src/middleware/rate-limit.ts`) cover the cheap reads. Each Functions
instance holds its own counters, so the effective ceiling for those routes is
roughly instances × the configured max. The limiter bounds its key map
(`RATE_LIMIT_MAX_TRACKED_KEYS`, default 10 000) so a flood of distinct keys
can't exhaust memory.

## Env overrides for the shared limits

| Limit | Env overrides |
|---|---|
| Lead: 10 / 60 s per IP | `LEAD_RATE_LIMIT_MAX_REQUESTS`, `LEAD_RATE_LIMIT_WINDOW_MS` |
| Estimate: 20 / hr per IP, 600 / hr per tenant (#737: covers the 10× launch target of 500 / hr) | `ESTIMATE_RATE_LIMIT_MAX_REQUESTS`, `ESTIMATE_RATE_LIMIT_WINDOW_MS`, `ESTIMATE_TENANT_RATE_LIMIT_MAX_REQUESTS`, `ESTIMATE_TENANT_RATE_LIMIT_WINDOW_MS` |
| Magic-link reissue: 1 email per 60 s per address, 5 sends / hr per address | `MAGIC_LINK_REISSUE_COOLDOWN_MS`, `MAGIC_LINK_MAX_SENDS_PER_HOUR` |

### `POST /api/v1/magic-link/reissue`: send-oracle note

A repeat reissue while a live link exists returns `{ sent: false }` without
sending. The cooldown starts only after a **delivered** email, so a failed
send leaves the window open for an immediate retry. Cooldown and budget
denials both answer `{ sent: false }`. That is the same answer as the
live-link, unknown-email and quarantined-lead cases, so the endpoint can't be
used as a send oracle.

## Reusable mechanism

`createRequestPipeline` (`apps/api/src/middleware/pipeline.ts`) accepts any
limiter, in-memory or shared. It takes:

- a `keyFor(request)` function (default: the client IP);
- an `extraLimiters` list of independent secondary budgets (for example,
  per-tenant for embed traffic).

New rate-limited routes should reuse this. Put a route on the shared store
when abuse costs money or sends mail.

## Not yet covered (tracked on #729)

These need owner input and are not implemented yet:

- global daily caps for LLM calls and outbound email;
- a lower Function App `maximumInstanceCount`;
- whether to add a bot challenge.

## Per-route limits (generated)

<!-- BEGIN GENERATED: rate limits from apps/api/src/registry/route-registry.ts — do not edit by hand -->
| Method | Path | Auth | Rate limit | Status |
|---|---|---|---|---|
| GET | `/api/health` | none | 100/min per IP | live |
| POST | `/api/v1/estimate` | none | 20/hr per IP · 600/hr per tenant (embed; #737, 10× launch target) | live |
| POST | `/api/v1/estimates/preview` | none | 20/hr per IP | live |
| POST | `/api/v1/leads` | none | 10/min per IP (dedicated lead limiter) | live |
| GET | `/api/v1/magic-link/verify` | magic-token | 100/min per IP | live |
| POST | `/api/v1/magic-link/reissue` | none | 60s cooldown · 5 sends/hr per email · 100/min per IP | live |
| GET | `/api/v1/reports/{reportToken}` | magic-token | 100/min per IP | live |
| POST | `/api/v1/reports/{reportToken}/revisions` | magic-token | 20/hr per IP | live |
| POST | `/api/v1/callbacks` | magic-token | 10/min per IP | live |
| POST | `/api/v1/waitlist` | none | 10/min per IP | live |
| POST | `/api/v1/shares` | magic-token | 10/min per IP | live |
| GET | `/api/v1/shares/verify` | magic-token | 100/min per IP | live |
| GET | `/api/v1/properties/autocomplete` | none | 60/min per IP | live |
| GET | `/api/v1/properties/lookup` | none | 60/min per IP | live |
| POST | `/api/v1/events` | none | 300/min per IP (dedicated analytics limiter) | live |
| GET | `/api/v1/privacy/export` | magic-token | 100/min per IP | live |
| POST | `/api/v1/privacy/erase-requests` | magic-token | 10/min per IP | live |
| POST | `/api/v1/privacy/erase-requests/{requestId}/confirm` | magic-token | 10/min per IP | live |
| POST | `/api/v1/estimates/{estimateId}/narrative` | magic-token | 100/min per IP + 5/day per estimate (cost guard) | live |
| GET | `/api/v1/unsubscribe/{token}` | magic-token | 100/min per IP | live |
| POST | `/api/v1/unsubscribe/{token}` | magic-token | 10/min per IP | live |
| GET | `/api/v1/communities/{slug}/stats` | none | 100/min per IP | live |
| GET | `/api/v1/city-data/freshness` | none | 100/min per IP | live |
| GET | `/api/v1/zoning/districts` | none | 100/min per IP | live |
| GET | `/api/v1/embed/config` | none | 120/min per tenant key | live |
| POST | `/api/v1/embed/session` | none | 30/min per tenant key | planned |
| POST | `/api/v1/embed/relay/resend` | none | 60s per code · 30/min per IP | live |
| POST | `/api/v1/chat/ask` | none | 20/hr per IP | planned |
| GET | `/api/v1/openapi.json` | none | 100/min per IP (1h cache) | live |
| GET | `/api/v1/admin/auth/me` | admin | 100/min per session | planned |
| POST | `/api/v1/admin/auth/logout` | admin | 10/min per session | planned |
| POST | `/api/v1/admin/auth/entra/callback` | none | 10/15min per IP | live |
| POST | `/api/v1/admin/view-as` | admin | 60/min per session | live |
| DELETE | `/api/v1/admin/view-as` | admin | 60/min per session | live |
| GET | `/api/v1/admin/search` | admin | 60/min per session + 300/min per IP (dedicated search limiters) | live |
| GET | `/api/v1/admin/users` | admin | 60/min per session | live |
| POST | `/api/v1/admin/users/invite` | admin | 20/min per session | live |
| GET | `/api/v1/admin/users/{id}` | admin | 60/min per session | live |
| PATCH | `/api/v1/admin/users/{id}` | admin | 60/min per session | live |
| DELETE | `/api/v1/admin/users/{id}` | admin | 20/min per session | live |
| POST | `/api/v1/admin/users/{id}/resend-invite` | admin | 20/min per session | live |
| POST | `/api/v1/admin/auth/switch-builder` | admin | 60/min per session | live |
| POST | `/api/v1/builder/auth/request` | none | 5 sends/hr per email · 100/min per IP | live |
| GET | `/api/v1/builder/auth/verify` | magic-token | 10/min per IP | live |
| GET | `/api/v1/builder/auth/me` | builder-session | 100/min per session | live |
| POST | `/api/v1/builder/auth/logout` | builder-session | 10/min per session | live |
| POST | `/api/v1/builder/auth/entra/callback` | none | 10/15min per IP | live |
| GET | `/api/v1/builder/auth/memberships` | builder-session | 100/min per session | live |
| POST | `/api/v1/builder/auth/active-org` | builder-session | 60/min per session | live |
| GET | `/api/v1/builder/users` | builder-session | 100/min per session | live |
| POST | `/api/v1/builder/view-as` | builder-session | 60/min per session | live |
| DELETE | `/api/v1/builder/view-as` | builder-session | 60/min per session | live |
| POST | `/api/v1/builder/users/invite` | builder-session | 20/min per session | live |
| PATCH | `/api/v1/builder/users/{id}` | builder-session | 60/min per session | live |
| POST | `/api/v1/builder/users/{id}/resend-invite` | builder-session | 20/min per session | live |
| DELETE | `/api/v1/builder/users/{id}` | builder-session | 60/min per session | live |
| GET | `/api/v1/builder/leads` | builder-session | 100/min per session | live |
| GET | `/api/v1/builder/leads/needs-you` | builder-session | 100/min per session | live |
| PATCH | `/api/v1/builder/leads/{id}` | builder-session | 100/min per session | live |
| POST | `/api/v1/builder/leads/{id}/mark-won` | builder-session | 100/min per session | live |
| GET | `/api/v1/builder/leads/{leadId}/comments` | builder-session | 100/min per session | live |
| POST | `/api/v1/builder/leads/{leadId}/comments` | builder-session | 100/min per session | live |
| PATCH | `/api/v1/builder/comments/{commentId}` | builder-session | 100/min per session | live |
| GET | `/api/v1/admin/leads/{leadId}/comments` | admin | 100/min per session | live |
| POST | `/api/v1/admin/leads/{leadId}/comments` | admin | 100/min per session | live |
| PATCH | `/api/v1/admin/comments/{commentId}` | admin | 100/min per session | live |
| DELETE | `/api/v1/admin/comments/{commentId}` | admin | 100/min per session | live |
| GET | `/api/v1/admin/api-keys` | admin | 100/min per session | live |
| POST | `/api/v1/admin/api-keys` | admin | 10/min per session | live |
| POST | `/api/v1/admin/api-keys/{id}/rotate` | admin | 10/min per session | live |
| POST | `/api/v1/admin/api-keys/{id}/revoke` | admin | 10/min per session | live |
| PATCH | `/api/v1/admin/api-keys/{id}` | admin | 10/min per session | live |
| GET | `/api/v1/admin/leads` | admin | 300/min per session | planned |
| GET | `/api/v1/admin/leads/{id}` | admin | 300/min per session | planned |
| POST | `/api/v1/admin/leads/{id}/notes` | admin | 60/min per session | planned |
| PATCH | `/api/v1/admin/leads/{id}/status` | admin | 60/min per session | planned |
| POST | `/api/v1/admin/leads/{id}/quarantine/approve` | admin | 60/min per session | live |
| POST | `/api/v1/admin/leads/{id}/quarantine/discard` | admin | 60/min per session | live |
| GET | `/api/v1/admin/leads/export.csv` | admin | 10/min per session | planned |
| POST | `/api/v1/admin/leads/{id}/assign-builder` | admin | 60/min per session | live |
| GET | `/api/v1/admin/builders` | admin | 300/min per session | live |
| POST | `/api/v1/admin/builders` | admin | 60/min per session | live |
| GET | `/api/v1/admin/builders/{id}` | admin | 300/min per session | live |
| PATCH | `/api/v1/admin/builders/{id}` | admin | 60/min per session | live |
| GET | `/api/v1/admin/estimates/{id}` | admin | 300/min per session | planned |
| POST | `/api/v1/admin/estimates/{id}/narrative` | admin | 60/min per session | live |
| GET | `/api/v1/admin/funnels` | admin | 300/min per session | live |
| GET | `/api/v1/admin/billing` | admin | 300/min per session | live |
| POST | `/api/v1/admin/billing/invoices/{id}/retry` | admin | 300/min per session | live |
| POST | `/api/v1/admin/billing/simulated/invoices/{id}/events` | admin | 300/min per session | live |
| POST | `/api/v1/admin/billing/invoices/{id}/mark-paid` | admin | 300/min per session | live |
| POST | `/api/v1/admin/billing/invoices/{id}/commission-rate` | admin | 300/min per session | live |
| PUT | `/api/v1/admin/billing/invoices/{id}/payment-method` | admin | 300/min per session | live |
| POST | `/api/v1/admin/billing/invoices/{id}/refund` | admin | 300/min per session | live |
| POST | `/api/v1/admin/billing/invoices/{id}/void` | admin | 300/min per session | live |
| POST | `/api/v1/admin/billing/invoices/{id}/correct-contract` | admin | 300/min per session | live |
| POST | `/api/v1/admin/billing/invoices/{id}/reverse-payment` | admin | 300/min per session | live |
| POST | `/api/v1/admin/billing/invoices` | admin | 300/min per session | live |
| POST | `/api/v1/admin/community-stats/refresh` | admin | 10/min per session | live |
| GET | `/api/v1/admin/usage` | admin | 300/min per session | planned |
| GET | `/api/v1/admin/calibration` | admin | 300/min per session | live |
| GET | `/api/v1/admin/ops/sheets-status` | admin | 300/min per session | live |
| POST | `/api/v1/admin/ops/sheets-sync-now` | admin | 10/min per session | live |
| POST | `/api/v1/builder/agreement/accept` | none | 10/min per IP | planned |
| GET | `/api/v1/builder/leads/{id}` | builder-session | 300/min per session | planned |
| POST | `/api/mcp/v1` | api-key | 100/min per key | live |
| POST | `/api/v1/stripe/webhooks` | stripe-signature | 100/min per IP | live |
| POST | `/api/v1/billing/report-contract` | builder-session | 100/min per session | live |
| POST | `/api/v1/billing/setup-intent` | builder-session | 100/min per session | live |
| POST | `/api/v1/billing/simulated/confirm-setup` | builder-session | 100/min per session | live |
| POST | `/api/v1/billing/simulated/authenticate` | builder-session | 100/min per session | live |
| GET | `/api/v1/billing/card` | builder-session | 100/min per session | live |
| DELETE | `/api/v1/billing/card` | builder-session | 100/min per session | live |
| GET | `/api/v1/billing/commission-rate` | builder-session | 100/min per session | live |
| GET | `/api/v1/builder/billing/overview` | builder-session | 100/min per session | live |
| GET | `/api/v1/billing/payment-method` | builder-session | 100/min per session | live |
| PUT | `/api/v1/billing/payment-method` | builder-session | 100/min per session | live |
| PUT | `/api/v1/billing/invoices/{id}/payment-method` | builder-session | 100/min per session | live |
| GET | `/api/v1/billing/invoices/{id}` | builder-session | 100/min per session | live |
| GET | `/api/v1/billing/invoices/{id}/pdf` | builder-session | 100/min per session | live |
| GET | `/api/v1/billing/invoices` | builder-session | 100/min per session | live |
| POST | `/api/v1/billing/invoices/{id}/dispute` | builder-session | 100/min per session | live |
| POST | `/api/v1/billing/invoices/{id}/resolve` | admin | 100/min per session | live |
| GET | `/api/v1/admin/disputes` | admin | 100/min per session | live |
| GET | `/api/v1/admin/disputes/{id}` | admin | 100/min per session | live |
| POST | `/api/v1/admin/disputes/{id}/accept` | admin | 100/min per session | live |
| POST | `/api/v1/admin/disputes/{id}/reject` | admin | 100/min per session | live |
<!-- END GENERATED: rate limits -->
