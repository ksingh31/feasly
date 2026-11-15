# Feasly SEO — tags, canonicals, and the SITE_URL story

Owner: SEO-01 (`SeoService`, `core/seo/`). This file is the trailing-slash
policy (story acceptance criterion 7) and the placeholder register for the
undecided production domain.

## Per-page tags

`SeoService.setForRoute(path)` is the single entry point. It resolves
`core/seo/seo-routes.ts` — the route table — and applies, idempotently:

- `<title>`, `meta[name=description]`
- `link[rel=canonical]` (self-referencing, always trailing-slash — see below)
- `og:type=website`, `og:title`, `og:description`, `og:url` (= canonical),
  `og:image` (absolute URL to `/assets/og/og-default.png`, 1200×630)
- `twitter:card=summary_large_image`, `twitter:title`, `twitter:description`,
  `twitter:image`
- `meta[name=robots]` — `noindex,nofollow` on noindex routes, removed elsewhere

Title/description copy comes from config-owned `copy.seo` keys (never
literals). Unknown paths fall back to the 404 entry (noindexed, never throws).

Static fallbacks for `/` live in `src/index.html`; the service overwrites them
at runtime and during prerender (Angular `Title`/`Meta` are SSR-safe).

## Prerendered routes

`prerender-routes.txt` (read by the Angular builder via `angular.json`) lists
`/`, `/privacy`, `/terms`, and `/404`, so their full tag sets — including
robots and canonicals — are baked into the served HTML for crawlers that
don't execute JS. The `/estimate/*` wizard routes are intentionally NOT
prerendered: they are noindexed app state, and `/estimate/scope` +
`/estimate/report` redirect to `/` during prerender (their guards find no
wizard state), so prerendering would only bake the redirect placeholder.
Their `noindex,nofollow` is applied at runtime by `robotsGuard` (which runs
before the redirect guards) and `SeoService.setForRoute()`, and pinned by
unit tests. The gate (`/preview`, `/check-email`, `/analyzing`), `/r/*`,
`/embed/*`, and `/admin/*` routes don't exist yet; they join the noindex
table (not the prerender list) when their stories land.

## Community pages (#690)

**Which communities get a page is config**, per city:
`apps/web/scripts/config/community-selection.json`. A community gets a page
when its boundary class + community structure match the rule (Calgary:
`Residential` and `INNER CITY` / `1950s` / `1960s/1970s` in the City's
Community District Boundaries, `surr-xmvs`), **or** it is on the include list,
**or** it is in the optional top-N by residential record count — minus the
exclude list, and only with at least `minRecords` (100) residential records.
The include list holds the 40 pages that existed before #690, so no indexed
URL disappears. Edit the JSON, not the scripts; a config edit regenerates the
data on the next build (the aggregates file records a hash of the selection).

**Averages.** Build-guide figures use single-detached and semi-detached homes
only (`sub_property_use` R110/R111/R120/R121 on the latest roll). A community
with fewer than `guide.minRecords` (50) such homes falls back to all
residential dwellings and always gets the profile page, never a guide.
Profile pages show the all-residential average (condos included; condo
common elements, parking and storage excluded).

**Page count (2026-11-15): 144** community pages (113 established/inner-city,
31 newer; 21 of them profile pages), 155 prerendered routes in total, 153
sitemap URLs. Full production build ~15 s locally (prerender included). The
index groups cards as "Established and inner-city communities" first, then
"Newer communities".

**Static Web Apps config size.** Each community needs an exact 301 rule in
`public/staticwebapp.config.json` (see the trailing-slash policy below), and
Static Web Apps rejects a config file over 20 KB. The checked-in file is
pretty-printed (~22 KB); the postbuild (`scripts/build-seo-artifacts.ts`)
writes the deployed copy minified (~17 KB) and fails the build above 20 KB,
and `tools/check-prerender-seo.mjs` checks the built file too. Roughly 30
more communities fit before the per-slug redirects need a different design.

## Noindex list

These routes render `<meta name="robots" content="noindex,nofollow">`
(they still emit self-referencing canonicals):

- `/estimate/*` (wizard + report — private estimate data)
- `/preview`, `/check-email`, `/analyzing` (gate flow, ships with the lead-gate story)
- `/r/*` (magic-link redemption — per-token URLs must never be indexed)
- `/embed/*` (builder white-label embeds — canonical lives on feasly.com)
- `/admin/*` (internal)
- `/404` and every unknown path (soft-404s must not be indexed)

The table also pre-declares the not-yet-built routes (`preview`,
`check-email`, `analyzing`, `r/:token`, `embed/**`, `admin/**`) so they are
noindexed from the day they ship. `robots.txt` stays `Allow: /` — exclusion
is per-page meta, not robots.txt, so a misconfigured deploy can't
accidentally deindex the marketing pages.

## Trailing-slash policy

**Canonical URLs always carry the trailing slash** (except the root, which is
`/`): e.g. `https://<SITE_URL>/communities/altadore/`,
`https://<SITE_URL>/privacy/`. Enforced in `SeoService.withTrailingSlash`;
internal links must use the trailing-slash form.

**No platform 301 for the global case (deliberate).** Azure SWA's `trailingSlash: "always"` is
global — it would 301 every asset, `/robots.txt`, `/sitemap.xml`, and
`/api/*` (a 301 converts POSTs to GETs on redirect-following clients, which
would break the estimate/lead API when it wires up off mocks). A scoped
`routes` rule is not expressible either: SWA wildcards (`/communities/*`)
also match the trailing-slash URL, so a redirect rule would loop, and
redirect targets are static strings (no slug capture).

**Per-slug exact 301s (implemented).** `staticwebapp.config.json` contains an
exact 301 redirect for every prerendered community slug:
`/communities/{slug}` → `/communities/{slug}/` (one rule per prerendered
community — 144 as of #690 — matching `prerender-routes.txt`). When a new community is added to the prerender list,
its 301 must be added to the config in the same change — the config test
(`staticwebapp.config.spec.ts`) fails if a prerendered slug lacks a redirect.
Until then, canonicals carry the policy and duplicate-content risk is contained.

## SITE_URL — the undecided domain [PLACEHOLDER]

`feasly.com` is **unverified** (Karan, 2026-09-24). Canonical/OG absolute URLs
resolve in this order (`SeoService.resolveSiteUrl`):

1. `SITE_URL` build-time env var (available during prerender/SSR in Node),
2. `site.url` from the served `/assets/config/app-config.json`,
3. the request origin at runtime — on SWA staging/preview environments this
   is the default `*.azurestaticapps.net` hostname,
4. the compiled `https://feasly.com` placeholder (prerender without
   `SITE_URL` only).

`tools/apply-site-url.mjs` (wired into the `@feasly/web` `prebuild` script)
writes `SITE_URL` into the served JSON; when unset it writes `""` (→ runtime
origin fallback). The committed JSON ships `""`; the compiled defaults keep
the placeholder so prerendered HTML still emits absolute tags. **When Karan
confirms the domain:** set `SITE_URL=https://<domain>` on the production
build only, and swap the placeholder in `app-config.defaults.ts`,
`src/index.html`, `public/robots.txt`, and `public/sitemap.xml`.

## Branded 404

`/404` and the wildcard route render `NotFoundPageComponent` (cream canvas,
"That page doesn't exist." / "The page you're looking for moved or never
existed." / "Back to home →").

Real 404 status (#490): `staticwebapp.config.json` has **no**
`navigationFallback` — SWA answers every unmatched path with HTTP 200 when it
is set, which made unknown URLs soft 404s. Instead:

- Prerendered routes (`prerender-routes.txt`) are served as their own
  `index.html` files — unaffected. SWA maps the no-slash form to the
  folder's `index.html` too: on the PR #566 preview, every `sitemap.xml` URL
  both with and without a trailing slash (`/privacy`, `/terms`, `/faq`,
  `/how-it-works`, `/developers`, `/guides/*`, `/communities`,
  `/communities/<slug>`) returned 200 with its own `<title>`. Unknown paths
  returned 404 with "Page not found".
- Client-only routes (`/estimate/*`, `/embed`, `/embed/*`, `/unsubscribe/*`,
  `/error`, `/admin`, `/admin/*`, `/builder`, `/builder/*`, `/r/*`) are an
  explicit allow-list of `rewrite: /index.html` rules so deep links and
  refreshes keep working.
- `/embed/v1/*` (the builder loader `embed/v1/loader.js`, built by
  `snippet/build.mjs`) has its own rule with no rewrite, placed before
  `/embed/*`. Route rewrites run before static files, so without it the
  loader would be served as `index.html` and every builder embed would
  break. Bump the rule when the loader's major version changes (the spec
  checks it against `FEASLY_LOADER_VERSION`).
- Everything else hits `responseOverrides.404 → /404.html` with
  `statusCode: 404`: the prerendered branded page, HTTP 404. `/404.html` is
  a flat copy of the prerendered `404/index.html` written by the postbuild
  step `scripts/build-404-page.ts` (a nested rewrite target broke for
  multi-segment unknown paths in the SWA emulator).

**Adding a new client-only (non-prerendered) top-level route? Add its
rewrite rule** — `staticwebapp-config.spec.ts` fails if any route in
`app.routes.ts` lacks one. Unknown community slugs are deliberately real 404s.
