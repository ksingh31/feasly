# Route audit — HRD-01 (2026-09-24)

Every route the platform serves, its intended audience, and its auth story.
Audited against `apps/web/public/staticwebapp.config.json`,
`apps/web/src/app/app.routes.ts`, and `apps/api/{estimate,leads,health}/function.json`.

## Static Web App (frontend)

| Route | Audience | Auth / access | Notes |
|---|---|---|---|
| `/` (landing) | Public | None | Indexable; `robotsGuard` allows crawlers |
| `/estimate/scope`, `/estimate/details` | Public (wizard) | `wizardPropertyGuard` redirects deep links without a selected property; `data.noindex` | No PII, no dollar figures pre-gate |
| `/estimate/report` | Public (wizard) | `reportEstimateGuard` (needs property + sqft); `data.noindex`; dollar figures blurred until the lead gate (PR #26) | Full numbers only post-gate |
| `/estimate/gate`, `/estimate/analyzing` | Public (wizard) | Arrive with PR #26 (lead gate + analyzing). Until then the report's Unlock CTA points at a not-yet-existing route and the `**` rule returns users to landing — no dead end, no leak | Tracked in PR #35 body |
| `/privacy`, `/terms` | Public | None | Legal pages, indexable |
| `/embed/*` | Builder tenants' sites (iframe) | Public embed route (embed/01 story, not yet built) | CSP `frame-ancestors` allows only the per-tenant allowlist; the current value is `https://PLACEHOLDER-TENANT.feasly.example` — **fail-closed by design**: it matches no real tenant, so framing is denied until embed/02 lands real origins. Must be replaced, never widened casually |
| `/assets/*`, `/robots.txt`, `/sitemap.xml`, `/llms.txt` | Public / crawlers | None | Excluded from the SPA navigation fallback |
| `**` (unknown paths) | Public | None | Redirects to `/` (Angular); the SWA navigation fallback serves `index.html` so client routing handles it. The SEO story adds a branded 404 page |
| `/api/*` | API clients | Proxied to the Function App (see below) | SWA `globalHeaders` still apply to proxied responses |

## Function App (API)

| Route | Audience | Auth / access | Notes |
|---|---|---|---|
| `POST /api/v1/estimate` | Public web app (same-origin via SWA) | `authLevel: anonymous` at the host; in-code fixed-window rate limiter; RFC 7807 errors | CORS: allowlisted origins only (`CORS_ORIGINS`; localhost dev-only). Preflight answered 204 before the pipeline |
| `POST /api/v1/leads` | Public web app (lead gate) | `authLevel: anonymous` by design; dedicated tight lead rate limiter; body never logged (PII) | Same CORS policy as estimate |
| `GET /api/health` | Public / monitors | None (status + version only, no data) | Standalone `index.js`, no dependencies, **no CORS headers** — cross-origin reads are fail-closed by default |
| `POST /api/v1/reports`, `/callbacks`, `/shares` | — | Do not exist yet | The report page runs on the mock harness in dev (`useMockApi: true`); real endpoints arrive with the gate/admin stories and get their own audit rows |

## Findings

1. **No internal route is accidentally public.** The only anonymous API routes are the two public wizard endpoints and the data-free health check. Admin routes do not exist yet (admin/01 adds them behind magic-link + allowlist); when they land, this doc must gain their rows.
2. **frame-ancestors is deny-by-default.** Global CSP sets `'none'`; only `/embed/*` overrides it, and the override currently points at a placeholder that matches nothing (fail-closed).
3. **CORS is allowlist-only, no wildcards.** Production has no localhost origins — they are injected only when `NODE_ENV=development`. `evil.example`-style origins receive no `Access-Control-Allow-Origin` (covered by `test/middleware-cors.test.ts`).
4. **Preflight does not touch the pipeline.** OPTIONS requests are answered 204 at the adapter edge — no rate-limit consumption, no DB work, no PII logging surface.
5. **navigationFallback excludes are correct.** `/assets/*`, `/robots.txt`, `/sitemap.xml`, `/llms.txt` bypass the SPA rewrite; everything else falls through to `index.html` with headers intact.

## Verification

- Static: `node apps/web/tools/check-security-headers.mjs` (wired into `npm run lint --workspace @feasly/web`; runs in CI).
- API CORS: `npm run test --workspace @feasly/api` → `test/middleware-cors.test.ts`.
- Live (preview deploy): fetch `/`, `/estimate/report`, `/privacy`, `/assets/<hash>.js`, a 404 path, and `POST /api/v1/estimate` with `Origin: https://evil.example` — all must carry the five headers; the evil origin must get no `Access-Control-Allow-Origin`.
