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
`/communities/{slug}` → `/communities/{slug}/` (40 rules, generated from
`prerender-routes.txt`). When a new community is added to the prerender list,
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
existed." / "Back to home →"). `staticwebapp.config.json` sets
`responseOverrides.404 → rewrite /index.html` so platform-level 404s
(e.g. missing files excluded from the fallback) land in the SPA shell.

Status-code nuance, stated honestly: SWA's `navigationFallback` serves
`/index.html` with **HTTP 200** for unknown SPA paths (the branded 404
renders client-side, noindexed, so crawlers treat it as a soft-404 and move
on). A true HTTP 404 status is returned only for platform-level 404s via
`responseOverrides`. This is the standard SPA-on-SWA trade-off; deep links
to real routes keep working, which matters more than the status code.
