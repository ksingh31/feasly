# Route audit — refreshed for go-live (#731, 2026-11-15)

Replaces HRD-01 (2026-09-24), which covered three API routes. The API
table below is **generated from `apps/api/src/registry/route-registry.ts`**
(method, path, auth, permissions, rate limit, status). The "Audit note"
column is human-written in `apps/api/src/registry/route-audit.ts`, and only
filled where a route needs specific scrutiny. CI fails when this table
drifts from the registry (`test/route-registry.conformance.test.ts`), so a
new route cannot ship without an audit row. Regenerate with:

```bash
cd apps/api && npx tsx tools/insert-route-audit-table.mts
```

Related: [rate-limits.md](rate-limits.md) · [asvs-l1.md](asvs-l1.md) ·
[threat-model.md](threat-model.md) · [pentest-checklist.md](pentest-checklist.md).

## How authorization is enforced

- **Registry-driven.** Every Function adapter runs
  `enforceRoutePermissions` (`apps/api/src/middleware/enforce-route-permissions.ts`)
  before the route. A route missing from the registry gets a 500 and serves
  no traffic. `permissions` (AND) and `permissionsAnyOf` (OR) come from the
  registry. A missing session gets a 401. A missing permission gets a 403
  that is written to the audit log.
- **Tenant scoping is server-side.** Builder routes scope SQL to the builder
  id resolved from the session (`requireBuilderId` / builder guard). The
  id is never read from the request. Cross-tenant ids return 404 or a 403 that
  is written to the audit log. No data is returned and nothing is changed
  (see `apps/api/test/tenant-isolation.test.ts`).
- **Credential-is-authorization routes** (`magic-token`, `api-key`,
  `stripe-signature`) declare `permissions: []` and check their own credential.
- **View-as** (admin → builder/user, builder admin → team member): admin
  targets are rejected. Activation, exit, and **every protected action taken
  under it** are logged under the real actor (`authz.view_as_action`,
  `test/view-as-audit-attribution.test.ts`).

## Function App (API) — generated

<!-- BEGIN GENERATED: route audit from apps/api/src/registry/route-registry.ts + route-audit.ts — do not edit by hand -->
| Method | Path | Auth | Permissions | Rate limit | Status | Audit note |
|---|---|---|---|---|---|---|
| GET | `/api/health` | none | — | 100/min per IP | live | Status + version only; no data, no CORS headers. |
| POST | `/api/v1/estimate` | none | — | 20/hr per IP · 600/hr per tenant (embed; #737, 10× launch target) | live | Anonymous by design; IP + tenant limits keyed on the unspoofable client IP (#729). |
| POST | `/api/v1/estimates/preview` | none | — | 20/hr per IP | live |  |
| POST | `/api/v1/leads` | none | — | 10/min per IP (dedicated lead limiter) | live | Anonymous by design; dedicated lead limiter; body never logged (PII). |
| GET | `/api/v1/magic-link/verify` | magic-token | — | 100/min per IP | live |  |
| POST | `/api/v1/magic-link/reissue` | none | — | 60s cooldown · 5 sends/hr per email · 100/min per IP | live | Same response whether or not the email exists (no account enumeration). |
| GET | `/api/v1/reports/{reportToken}` | magic-token | — | 100/min per IP | live | Token is the credential: hashed at rest, expiring; unknown/expired token never returns another lead’s report. |
| POST | `/api/v1/reports/{reportToken}/revisions` | magic-token | — | 20/hr per IP | live | Token is the credential; revision lands on the token’s own lead only. |
| POST | `/api/v1/callbacks` | magic-token | — | 10/min per IP | live |  |
| POST | `/api/v1/waitlist` | none | — | 10/min per IP | live |  |
| POST | `/api/v1/shares` | magic-token | — | 10/min per IP | live |  |
| GET | `/api/v1/shares/verify` | magic-token | — | 100/min per IP | live |  |
| GET | `/api/v1/properties/autocomplete` | none | — | 60/min per IP | live | SSRF surface: same fixed-host rule as lookup. |
| GET | `/api/v1/properties/lookup` | none | — | 60/min per IP | live | SSRF surface: outbound calls go only to fixed City of Calgary hosts from config; the address is a query value, never a URL. |
| POST | `/api/v1/events` | none | — | 300/min per IP (dedicated analytics limiter) | live | Anonymous analytics; dedicated limiter; schema-validated, no free-text PII fields. |
| GET | `/api/v1/privacy/export` | magic-token | — | 100/min per IP | live |  |
| POST | `/api/v1/privacy/erase-requests` | magic-token | — | 10/min per IP | live |  |
| POST | `/api/v1/privacy/erase-requests/{requestId}/confirm` | magic-token | — | 10/min per IP | live | Token must belong to the same identity as the request id: unknown id 404, cross-user id 403 + audit (ids are random UUIDs). |
| POST | `/api/v1/estimates/{estimateId}/narrative` | magic-token | — | 100/min per IP + 5/day per estimate (cost guard) | live | LLM cost surface: per-estimate daily cap; LLM writes narrative only, never dollar figures. |
| GET | `/api/v1/unsubscribe/{token}` | magic-token | — | 100/min per IP | live | Signed token; GET is read-only (mail scanners prefetch links), POST performs the opt-out. |
| POST | `/api/v1/unsubscribe/{token}` | magic-token | — | 10/min per IP | live |  |
| GET | `/api/v1/communities/{slug}/stats` | none | — | 100/min per IP | live |  |
| GET | `/api/v1/city-data/freshness` | none | — | 100/min per IP | live |  |
| GET | `/api/v1/zoning/districts` | none | — | 100/min per IP | live |  |
| GET | `/api/v1/embed/config` | none | — | 120/min per tenant key | live | Public tenant config only; rates/margins never serialized (secret-leak test). |
| POST | `/api/v1/embed/session` | none | — | 30/min per tenant key | planned | Not live yet. Must get origin-allowlist and tenant-key checks before going live. |
| POST | `/api/v1/embed/relay/resend` | none | — | 60s per code · 30/min per IP | live |  |
| POST | `/api/v1/chat/ask` | none | — | 20/hr per IP | planned | Not live yet. Prompt injection + LLM cost: needs a per-IP and global budget and an output filter before going live. |
| GET | `/api/v1/openapi.json` | none | — | 100/min per IP (1h cache) | live | Public by design (agent API docs); spec carries no rates, margins or secrets. |
| GET | `/api/v1/admin/auth/me` | admin | — | 100/min per session | planned |  |
| POST | `/api/v1/admin/auth/logout` | admin | — | 10/min per session | planned |  |
| POST | `/api/v1/admin/auth/entra/callback` | none | — | 10/15min per IP | live |  |
| POST | `/api/v1/admin/view-as` | admin | view_as | 60/min per session | live | Impersonation: admin targets rejected; activation, every action under it, and exit are audit-logged as the real actor. |
| DELETE | `/api/v1/admin/view-as` | admin | — | 60/min per session | live | Exit is audit-logged as the real actor. |
| GET | `/api/v1/admin/search` | admin | leads:read | 60/min per session + 300/min per IP (dedicated search limiters) | live |  |
| GET | `/api/v1/admin/users` | admin | any:users:manage, any:builder:users:manage | 60/min per session | live |  |
| POST | `/api/v1/admin/users/invite` | admin | any:users:manage, any:builder:users:manage | 20/min per session | live |  |
| GET | `/api/v1/admin/users/{id}` | admin | any:users:manage, any:builder:users:manage | 60/min per session | live |  |
| PATCH | `/api/v1/admin/users/{id}` | admin | any:users:manage, any:builder:users:manage | 60/min per session | live |  |
| DELETE | `/api/v1/admin/users/{id}` | admin | users:manage | 20/min per session | live |  |
| POST | `/api/v1/admin/users/{id}/resend-invite` | admin | any:users:manage, any:builder:users:manage | 20/min per session | live |  |
| POST | `/api/v1/admin/auth/switch-builder` | admin | — | 60/min per session | live |  |
| POST | `/api/v1/builder/auth/request` | none | — | 5 sends/hr per email · 100/min per IP | live |  |
| GET | `/api/v1/builder/auth/verify` | magic-token | — | 10/min per IP | live |  |
| GET | `/api/v1/builder/auth/me` | builder-session | — | 100/min per session | live |  |
| POST | `/api/v1/builder/auth/logout` | builder-session | — | 10/min per session | live |  |
| POST | `/api/v1/builder/auth/entra/callback` | none | — | 10/15min per IP | live |  |
| GET | `/api/v1/builder/auth/memberships` | builder-session | — | 100/min per session | live |  |
| POST | `/api/v1/builder/auth/active-org` | builder-session | — | 60/min per session | live |  |
| GET | `/api/v1/builder/users` | builder-session | builder:users:manage | 100/min per session | live |  |
| POST | `/api/v1/builder/view-as` | builder-session | view_as | 60/min per session | live | Impersonation within one org only; admin targets rejected; audit-logged as the real actor. |
| DELETE | `/api/v1/builder/view-as` | builder-session | — | 60/min per session | live | Exit is audit-logged as the real actor. |
| POST | `/api/v1/builder/users/invite` | builder-session | builder:users:manage | 20/min per session | live |  |
| PATCH | `/api/v1/builder/users/{id}` | builder-session | builder:users:manage | 60/min per session | live |  |
| POST | `/api/v1/builder/users/{id}/resend-invite` | builder-session | builder:users:manage | 20/min per session | live |  |
| DELETE | `/api/v1/builder/users/{id}` | builder-session | builder:users:manage | 60/min per session | live |  |
| GET | `/api/v1/builder/leads` | builder-session | builder:leads:read | 100/min per session | live |  |
| GET | `/api/v1/builder/leads/needs-you` | builder-session | builder:leads:read | 100/min per session | live |  |
| PATCH | `/api/v1/builder/leads/{id}` | builder-session | builder:leads:manage | 100/min per session | live |  |
| POST | `/api/v1/builder/leads/{id}/mark-won` | builder-session | builder:leads:manage | 100/min per session | live |  |
| GET | `/api/v1/builder/leads/{leadId}/comments` | builder-session | builder:leads:read | 100/min per session | live |  |
| POST | `/api/v1/builder/leads/{leadId}/comments` | builder-session | builder:leads:manage | 100/min per session | live |  |
| PATCH | `/api/v1/builder/comments/{commentId}` | builder-session | builder:leads:manage | 100/min per session | live |  |
| GET | `/api/v1/admin/leads/{leadId}/comments` | admin | leads:read | 100/min per session | live |  |
| POST | `/api/v1/admin/leads/{leadId}/comments` | admin | leads:manage | 100/min per session | live |  |
| PATCH | `/api/v1/admin/comments/{commentId}` | admin | leads:manage | 100/min per session | live |  |
| DELETE | `/api/v1/admin/comments/{commentId}` | admin | leads:manage | 100/min per session | live |  |
| GET | `/api/v1/admin/api-keys` | admin | api_keys:manage | 100/min per session | live |  |
| POST | `/api/v1/admin/api-keys` | admin | api_keys:manage | 10/min per session | live |  |
| POST | `/api/v1/admin/api-keys/{id}/rotate` | admin | api_keys:manage | 10/min per session | live |  |
| POST | `/api/v1/admin/api-keys/{id}/revoke` | admin | api_keys:manage | 10/min per session | live |  |
| PATCH | `/api/v1/admin/api-keys/{id}` | admin | api_keys:manage | 10/min per session | live |  |
| GET | `/api/v1/admin/leads` | admin | leads:read | 300/min per session | planned |  |
| GET | `/api/v1/admin/leads/{id}` | admin | leads:read | 300/min per session | planned |  |
| POST | `/api/v1/admin/leads/{id}/notes` | admin | leads:manage | 60/min per session | planned |  |
| PATCH | `/api/v1/admin/leads/{id}/status` | admin | leads:manage | 60/min per session | planned |  |
| POST | `/api/v1/admin/leads/{id}/quarantine/approve` | admin | leads:manage | 60/min per session | live |  |
| POST | `/api/v1/admin/leads/{id}/quarantine/discard` | admin | leads:manage | 60/min per session | live |  |
| GET | `/api/v1/admin/leads/export.csv` | admin | leads:read | 10/min per session | planned | CSV cells beginning with = + - @ (or tab/CR) are prefixed with a quote (formula-injection test). Sheets sync writes with valueInputOption RAW, so cells are never evaluated. |
| POST | `/api/v1/admin/leads/{id}/assign-builder` | admin | leads:assign | 60/min per session | live |  |
| GET | `/api/v1/admin/builders` | admin | builders:read | 300/min per session | live |  |
| POST | `/api/v1/admin/builders` | admin | builders:manage | 60/min per session | live |  |
| GET | `/api/v1/admin/builders/{id}` | admin | builders:read | 300/min per session | live |  |
| PATCH | `/api/v1/admin/builders/{id}` | admin | builders:manage | 60/min per session | live |  |
| GET | `/api/v1/admin/estimates/{id}` | admin | estimates:read | 300/min per session | planned |  |
| POST | `/api/v1/admin/estimates/{id}/narrative` | admin | estimates:read | 60/min per session | live |  |
| GET | `/api/v1/admin/funnels` | admin | analytics:read | 300/min per session | live |  |
| GET | `/api/v1/admin/billing` | admin | billing:read | 300/min per session | live |  |
| POST | `/api/v1/admin/billing/invoices/{id}/retry` | admin | billing:manage | 300/min per session | live |  |
| POST | `/api/v1/admin/billing/invoices/{id}/mark-paid` | admin | billing:manage | 300/min per session | live |  |
| POST | `/api/v1/admin/billing/invoices/{id}/commission-rate` | admin | billing:manage | 300/min per session | live |  |
| PUT | `/api/v1/admin/billing/invoices/{id}/payment-method` | admin | billing:manage | 300/min per session | live |  |
| POST | `/api/v1/admin/billing/invoices` | admin | billing:manage | 300/min per session | live |  |
| POST | `/api/v1/admin/community-stats/refresh` | admin | ops:manage | 10/min per session | live |  |
| GET | `/api/v1/admin/usage` | admin | usage:read | 300/min per session | planned |  |
| GET | `/api/v1/admin/calibration` | admin | calibration:read | 300/min per session | live |  |
| GET | `/api/v1/admin/ops/sheets-status` | admin | ops:manage | 300/min per session | live |  |
| POST | `/api/v1/admin/ops/sheets-sync-now` | admin | ops:manage | 10/min per session | live |  |
| POST | `/api/v1/builder/agreement/accept` | none | — | 10/min per IP | planned | Not live yet. Planned as `auth: none`; must bind acceptance to a builder session or a single-use token before going live. |
| GET | `/api/v1/builder/leads/{id}` | builder-session | builder:leads:read | 300/min per session | planned |  |
| POST | `/api/mcp/v1` | api-key | — | 100/min per key | live | API-key scopes are the authorization; per-key limit; same engine as the public API. |
| POST | `/api/v1/stripe/webhooks` | stripe-signature | — | 100/min per IP | live | Stripe-Signature verified with timestamp tolerance; processed event ids are stored, so a replayed event is a no-op. |
| POST | `/api/v1/billing/report-contract` | builder-session | builder:billing | 100/min per session | live |  |
| POST | `/api/v1/billing/setup-intent` | builder-session | builder:billing | 100/min per session | live |  |
| GET | `/api/v1/billing/card` | builder-session | builder:billing | 100/min per session | live |  |
| GET | `/api/v1/billing/commission-rate` | builder-session | builder:billing | 100/min per session | live |  |
| GET | `/api/v1/builder/billing/overview` | builder-session | builder:billing | 100/min per session | live |  |
| GET | `/api/v1/billing/payment-method` | builder-session | builder:billing | 100/min per session | live |  |
| PUT | `/api/v1/billing/payment-method` | builder-session | builder:billing | 100/min per session | live |  |
| PUT | `/api/v1/billing/invoices/{id}/payment-method` | builder-session | builder:billing | 100/min per session | live |  |
| GET | `/api/v1/billing/invoices/{id}` | builder-session | builder:billing | 100/min per session | live |  |
| GET | `/api/v1/billing/invoices/{id}/pdf` | builder-session | builder:billing | 100/min per session | live |  |
| GET | `/api/v1/billing/invoices` | builder-session | builder:billing | 100/min per session | live |  |
| POST | `/api/v1/billing/invoices/{id}/dispute` | builder-session | builder:billing | 100/min per session | live |  |
| POST | `/api/v1/billing/invoices/{id}/resolve` | admin | billing:manage | 100/min per session | live |  |
| GET | `/api/v1/admin/disputes` | admin | billing:read | 100/min per session | live |  |
| GET | `/api/v1/admin/disputes/{id}` | admin | billing:read | 100/min per session | live |  |
| POST | `/api/v1/admin/disputes/{id}/accept` | admin | billing:manage | 100/min per session | live |  |
| POST | `/api/v1/admin/disputes/{id}/reject` | admin | billing:manage | 100/min per session | live |  |
<!-- END GENERATED: route audit -->

Non-registry HTTP surface: CORS preflight (`OPTIONS`) is answered 204 at
the adapter edge before the pipeline runs (no rate-limit use, no DB work).

## Static Web App (frontend)

| Route | Audience | Auth / access | Notes |
|---|---|---|---|
| `/`, community/SEO pages | Public | None | Indexable |
| `/estimate/*` | Public (wizard) | Route guards; `noindex` | Pre-gate figures are blurred. Owner decision 2026-11-13: being readable in the DOM is acceptable. |
| `/report/*`, magic-link landing | Lead (token holder) | Token in URL → API `magic-token` routes | Token never logged |
| `/builder/*` | Builder users | Builder session (Entra / magic link) → API `builder-session` routes | UI guards are UX only. The API enforces access. |
| `/admin/*` | Staff | Admin session (Entra) → API `admin` routes | UI guards are UX only. The API enforces access. |
| `/embed/*` | Builder tenants' sites (iframe) | Public | CSP `frame-ancestors` is `'self'` + the per-tenant allowlist generated from `config/builders/*.json` by `apps/web/tools/sync-embed-csp.mjs` (lint fails if out of sync). IANA-reserved placeholder origins such as `demo.example.com` are skipped (F-3, fixed in #796). |
| `/assets/*`, `/robots.txt`, `/sitemap.xml`, `/llms.txt` | Public / crawlers | None | Never rewritten to the SPA |
| `/api/*` | API clients | Proxied to the Function App | SWA `globalHeaders` apply |

Headers are enforced by `apps/web/tools/check-security-headers.mjs`, which runs in CI lint.

## Findings (2026-11-15)

| # | Severity | Finding | Status |
|---|---|---|---|
| F-1 | Medium | View-as actions on routes gated only by `permissionsAnyOf` (admin user management: list/get/invite/update/resend) were not written to the audit log. | **Fixed in #731**: `enforceRoutePermissions` now always runs the view-as audit for session-protected routes. Covered by a regression test. |
| F-2 | Info | Planned anonymous routes (`POST /api/v1/builder/agreement/accept`, `POST /api/v1/chat/ask`, `POST /api/v1/embed/session`) are **not live**. Each audit note lists the control it needs before it goes live. | Gate on go-live of each route |
| F-3 | Low | `/embed` `frame-ancestors` listed `https://demo.example.com`. | **Fixed** (#796, PR #809): reserved placeholder origins are skipped when the CSP is generated. |
| F-4 | Info | The repo is public (owner decision 2026-11-15: stays public). The docs reveal resource names and tenant IDs. These aren't secrets, but they map the system for an attacker. | Personal-detail scrub tracked in #758 |
| F-5 | Low | SWA CSP `script-src` includes `'unsafe-eval'`. | #797 |
| F-6 | Medium | Cookie-authenticated, state-changing requests had no Origin/CSRF check. Session cookies are `SameSite=None`. Bearer-header auth, which the SPA uses first, is not affected. | **Fixed** (#794, PR #813): cookie-authenticated state-changing requests from non-allowlisted origins are rejected. |
| F-7 | Low | Authenticated JSON responses outside billing and admin search didn't send `Cache-Control: no-store`. | **Fixed** (#795, PR #810): API responses send `no-store` by default. |

No High finding is open.

## Owner decisions recorded

- **Repo visibility (2026-11-15):** keep the repository public for now. Making it private
  costs Actions minutes and branch protection. Scrubbing personal identifiers from docs is #758.
- **Third-party pen test:** not proposed (paid). Launch relies on the self-review in
  [asvs-l1.md](asvs-l1.md) and the run log in [pentest-checklist.md](pentest-checklist.md).
  Commissioning an external test needs explicit owner approval.
