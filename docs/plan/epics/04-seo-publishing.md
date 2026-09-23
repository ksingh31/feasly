# EPIC 04 — SEO Publishing

**Owner:** TPM (implementation epics)
**Area:** `apps/web` build pipeline + CI (`.github/workflows/`)
**Milestone coverage:** M0/M1 (SEO-first is an M0 requirement per ADR-001 amendment)

## Goal

Make Feasly crawler-, scraper-, and AI-agent-visible from day one: a
build-time programmatic community cost-page pipeline (the core content engine),
per-page titles/meta/OG, generated sitemap.xml + robots.txt, Schema.org
JSON-LD (FAQPage, LocalBusiness), llms.txt + llms-full.txt, canonical URLs
with a trailing-slash policy, a branded 404, a Core Web Vitals budget enforced
by a Lighthouse CI gate, internal linking via a community index page, and a
prerender route manifest covering public routes only (`/r/{token}` never
prerendered).

## Non-goals

- Paid search campaigns (Karan runs the ~$1.5k/mo test separately; this epic
  covers organic/technical only).
- Content marketing / blog engine (future; the pipeline is built so a
  `/guides/*` section can reuse it later).
- Multi-city pages (Calgary-only in M1; pipeline takes `city_slug` as a
  parameter so expansion is config, not rework).
- Sold-price or market-trend content (banned — City-assessed data only,
  honestly labeled).

## Key decisions

1. **Build-time generation, not runtime SSR:** community pages are prerendered
   HTML at build time from (a) City assessment aggregates cached in the repo
   (`apps/web/src/content/data/community-aggregates.json`, refreshed by a
   script) and (b) the frozen cost engine's public ranges. Fits SWA free tier,
   zero runtime cost, instant crawler serving.
2. **Community data source:** a build script `scripts/build-community-data.ts`
   queries the Socrata `4bsw-nn7w` dataset (or the `properties` cache DB) for
   per-community aggregates — count, avg assessed value, avg lot sqft —
   and writes the JSON. The page template calls the cost engine with
   `avg_lot_sqft` per community to produce cost-to-build ranges. No per_sqft
   or margins ever touch the content JSON (reuse ENG-008's deny-list scan on
   the generated files).
3. **URL scheme:** `/communities/` (index) and `/communities/{community-slug}/`
   (e.g. `/communities/altadore/`). Trailing slash enforced: canonical always
   has the trailing slash; non-slash 301-redirects (SWA `staticwebapp.config.json`
   routes). Slugs are kebab-case, derived from City community names.
4. **How many pages at launch:** top 40 Calgary communities by assessment
   record count (config `COMMUNITY_PAGE_LIMIT=40` in the build script) —
   enough for a real content engine, small enough to keep build times sane.
   The index page links all 40; the rest are reachable via search, not linked
   (avoids thin-content sprawl).
5. **Numbers on community pages are ranges from the frozen engine version**,
   labeled "based on City-assessed values" with the page's `cost_data_version`
   in a `<meta name="feasly:cost-data-version">` tag — reproducible and honest.
6. **llms.txt as a first-class artifact:** generated at build from the same
   content source (community summaries + how-it-works + FAQ), so AI agents get
   a clean, current representation without scraping HTML.

---

## Stories (dependency order)

### SEO-001 — Community data build script + aggregates JSON
**Description:** `apps/web/scripts/build-community-data.ts`: fetches
per-community aggregates (record count, avg assessed value, avg lot sqft,
community name) for Calgary from the Socrata dataset (via the API's cached
`properties` table when available, direct Socrata read as fallback), filters
to the top `COMMUNITY_PAGE_LIMIT` (default 40) by record count, and writes
`apps/web/src/content/data/community-aggregates.json`:
`{ generated_at, cost_data_version, communities: [{ slug, name, count,
avg_assessed_value, avg_lot_sqft }] }`. Runs as a `prebuild` step; CI fails
if the JSON is older than 30 days (stale-data guard forces a refresh).

**Acceptance criteria:**
- Script runs with `DATABASE_URL` unset (falls back to Socrata) and with it
  set (uses `properties` cache) — both paths tested with fixtures.
- Output JSON validates against a zod schema (checked into the repo);
  community slugs are kebab-case and unique.
- Avg assessed values are integers; no per_sqft/margin fields present
  (deny-list scan from ENG-008 reused on the JSON).
- CI freshness check: build fails if `generated_at` > 30 days old, with a
  message telling the operator to re-run the script.

**Dependencies:** WEB-001 (apps/web exists); Socrata access pattern from the API layer.
**Size:** M

### SEO-002 — Community page template (`/communities/{slug}/`)
**Description:** Angular route `/communities/:slug` prerendered per community:
H1 "How much does it cost to build a home in {Community}, Calgary?"; stat
block (avg City-assessed value — real, from aggregates JSON; community name);
cost-to-build range section computed at build time by running the frozen
cost engine (comparison-style math: land = avg_lot_sqft × neighbourhood
avg $/sqft ±10%, build = 2,400 sqft × tier params, total summed) for all
three tiers, presented as ranges with the "City-assessed basis" label;
FAQ section (5 questions: what the range covers, assessed vs market value,
why ranges not fixed prices, what's excluded, next step CTA); CTA card
"Get your address-specific estimate →" linking to `/estimate/address`.
Per-page `<title>`, meta description, OG tags (title/description/image,
`og:url` = canonical), Twitter card.

**Acceptance criteria:**
- All 40 pages prerender in `ng build` (assert 40 HTML files under
  `dist/.../communities/`).
- Each page's `<title>` is unique and matches
  `"Cost to Build a Home in {Name}, Calgary | Feasly"` (test over all files).
- No per_sqft, margins, or param tables in any page HTML (deny-list scan).
- Figures on a sample page recompute identically from the aggregates JSON +
  frozen engine version (reproducibility test).
- FAQ copy contains no accuracy guarantees and no sold-price claims (copy-lint).

**Dependencies:** SEO-001; ENG-002/ENG-004 (engine callable at build time via ts-node script — engine stays server-side conceptually; build-time use is fine since output is ranges only).
**Size:** M

### SEO-003 — Per-page titles/meta/OG for app routes
**Description:** `SeoService` (`apps/web/src/app/core/services/seo.service.ts`)
setting `<title>`, meta description, canonical link, OG tags, and Twitter
cards per route: `/` (landing), `/estimate/*` (wizard steps — `noindex`,
they're funnel not content), `/preview` (`noindex`), `/check-email`
(`noindex`), `/privacy`, `/terms`, `/communities/` + `/communities/:slug`
(indexable). Default fallback tags for unknown routes. OG image:
`assets/og/og-default.png` (branded, 1200×630, generated from the theme —
static asset checked in).

**Acceptance criteria:**
- Prerendered HTML for `/` contains the full tag set (title, description,
  canonical, og:*, twitter:*) — grep test on dist output.
- Wizard/preview/check-email/report pages carry `<meta name="robots"
  content="noindex,nofollow">` (assert on each).
- `og:image` URL is absolute (`https://feasly.com/assets/og/og-default.png`
  or the configured domain — from an environment-sourced `SITE_URL`, never hardcoded per-env).
- Unknown route falls back to default tags without throwing (unit test).

**Dependencies:** WEB-001
**Size:** S

### SEO-004 — sitemap.xml + robots.txt generation in CI
**Description:** Build script `apps/web/scripts/build-seo-artifacts.ts` (runs
in CI after prerender): `sitemap.xml` listing `/`, `/privacy`, `/terms`,
`/communities/`, and all 40 `/communities/{slug}/` with `<lastmod>` =
aggregates `generated_at` and sensible `changefreq`/`priority`
(community pages `monthly`/`0.8`, index `weekly`/`0.9`, landing `weekly`/`1.0`).
`robots.txt`: allow all, `Sitemap:` absolute URL, disallow `/r/`,
`/estimate/`, `/preview`, `/check-email`, `/api/`. Both written to the
SWA output dir. CI test asserts `/r/{token}` URLs never appear in the sitemap
and every prerendered community page does.

**Acceptance criteria:**
- `sitemap.xml` is valid XML (parsed in test) with 44 URLs (1 landing +
  2 legal + 1 index + 40 community).
- `robots.txt` disallows `/r/`, `/estimate/`, `/preview`, `/check-email`, `/api/`.
- Sitemap test fails the build if any prerendered community route is missing
  from the sitemap (parity check against the prerender manifest).
- `Sitemap:` line uses the absolute site URL from the same `SITE_URL` source as SEO-003.

**Dependencies:** SEO-001, SEO-002
**Size:** S

### SEO-005 — Schema.org JSON-LD (FAQPage, LocalBusiness)
**Description:** Inject JSON-LD per page type via `SeoService`: community
pages get `FAQPage` (the 5 FAQs from SEO-002, questions/answers verbatim from
the rendered copy — single source, no drift) + `RealEstateAgent`-adjacent
`LocalBusiness` (name "Feasly", areaServed "Calgary, AB", url canonical;
**no** fake address/phone — `NEEDS-KARAN`: confirm whether a public contact
phone/address may be listed, else omit). Landing gets `WebSite` + `FAQPage`
(how-it-works). Validate with a JSON-LD schema test (required fields present,
no `null` values emitted).

**Acceptance criteria:**
- Every community page HTML contains exactly one `FAQPage` script and one
  `LocalBusiness` script; Google's Rich Results expectations met (required
  fields: `mainEntity` with ≥3 questions, `name`, `areaServed`).
- FAQ answers in JSON-LD byte-match the rendered FAQ copy (drift test).
- No invented phone/address in LocalBusiness (test asserts absence unless
  Karan provides one).

**Dependencies:** SEO-002, SEO-003
**Size:** S
**NEEDS-KARAN:** Public contact phone/address for LocalBusiness markup (or confirm omission).

### SEO-006 — llms.txt + llms-full.txt
**Description:** Build script extends SEO-004's artifact step: `llms.txt`
(concise: what Feasly is, how it works, the 40 community summaries with avg
assessed values + build-cost ranges, FAQ pointers, canonical URLs) and
`llms-full.txt` (full: everything in llms.txt + complete FAQ answers +
methodology note: deterministic engine, City-assessed basis, version string).
Regenerated every build from the same content source as the HTML pages
(no hand-maintained copy). Linked from `robots.txt` is NOT standard —
instead reference via `<link rel="llms">`? Current call: just serve the files
at root; note the convention in README.

**Acceptance criteria:**
- Both files exist in the SWA output root; `llms.txt` < 50KB, `llms-full.txt` < 500KB.
- Community figures in llms.txt match the corresponding community page HTML
  (parity test over all 40).
- No deny-list terms (per_sqft/margins) in either file.
- `cost_data_version` stated in both files.

**Dependencies:** SEO-001, SEO-002
**Size:** S

### SEO-007 — Canonical URLs + trailing-slash policy + 404
**Description:** SWA `staticwebapp.config.json`: (a) 301 redirect non-trailing-slash
→ trailing-slash for `/communities/*` routes; (b) every indexable page emits
`<link rel="canonical" href="{SITE_URL}{path-with-trailing-slash}">` via
`SeoService`; (c) branded 404 page (`/404`, prerendered, canvas background,
"That page doesn't exist." + CTA back to `/`) served for unknown routes with
a real 404 status (SWA `responseOverrides`). Trailing-slash policy documented
in `apps/web/SEO.md`.

**Acceptance criteria:**
- Canonical on `/communities/altadore/` is exactly `{SITE_URL}/communities/altadore/`.
- Requesting `/communities/altadore` (no slash) 301s to the slashed version
  (config test against `staticwebapp.config.json` routes).
- Unknown path serves the branded 404 with HTTP 404 status (SWA config test).
- Noindex pages (`/estimate/*`, etc.) still emit canonicals (self-referencing) —
  canonical ≠ indexable.

**Dependencies:** SEO-003; WEB-001 (config file location).
**Size:** S

### SEO-008 — Community index page (`/communities/`) + internal linking
**Description:** Prerendered `/communities/` index: H1 "Calgary Community
Build-Cost Guides", intro copy, linked card grid of all 40 communities (name,
avg assessed value, "from $X" lowest-tier range teaser), each card linking to
its community page. Landing page links to `/communities/` ("Browse community
guides"). Each community page links back to the index + 3 "nearby communities"
(same quadrant or adjacent — from a static adjacency map in the aggregates
script, best-effort; falls back to 3 highest-count communities).

**Acceptance criteria:**
- Index page lists exactly 40 cards, all linking to live prerendered pages
  (link-integrity test: every `href` resolves to a file in dist).
- Every community page has ≥4 internal links (index + 3 nearby) — crawl-depth test.
- Landing page contains a visible link to `/communities/`.
- No orphan community page (each reachable from the index within 1 hop).

**Dependencies:** SEO-002
**Size:** S

### SEO-009 — Core Web Vitals budget + Lighthouse CI gate
**Description:** Define budgets in `apps/web/budgets.json` (and Angular build
`budgets` for bundle sizes): LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1, total blocking
time ≤ 200ms, JS bundle initial ≤ 200KB gzipped, image weight per page ≤ 500KB.
GitHub Actions workflow `lighthouse.yml`: runs Lighthouse CI on the PR preview
URL against `/`, `/communities/`, and 3 sampled community pages; fails the PR
if any threshold is breached. Baselines committed; the gate is blocking for
`main`.

**Acceptance criteria:**
- `lighthouse.yml` exists, runs on PRs, and is a required check for `main`.
- Thresholds: Performance ≥ 90, Accessibility ≥ 95, Best Practices ≥ 90, SEO = 100
  on all audited URLs (SEO 100 is non-negotiable for this epic).
- A deliberately oversized image (test fixture) fails the image-weight budget —
  proves the gate bites.
- Budget file documents the "how to buy back budget" rule: any PR that grows
  JS >5KB gzipped must note the tradeoff in the PR description (enforced by a
  bot comment, not a hard fail — softer than the Lighthouse gate).

**Dependencies:** WEB-001 (baseline build); SWA PR preview environments (M0).
**Size:** M

### SEO-010 — Prerender route manifest (public routes only)
**Description:** `apps/web/prerender-manifest.json` (checked in, generated by
`scripts/build-prerender-manifest.ts` from the aggregates JSON): explicit list
of prerendered routes — `/`, `/privacy`, `/terms`, `/estimate/address`,
`/communities/`, `/communities/{40 slugs}`. Build fails if (a) a route in the
manifest isn't emitted, or (b) any emitted route isn't in the manifest
(bidirectional parity — catches both missing pages and accidental new public
routes). Explicit blocklist asserted: `/r/*`, `/preview`, `/check-email`,
`/analyzing`, `/estimate/scope`, `/estimate/details` (wizard steps beyond the
entry are CSR; only `/estimate/address` prerenders as the deep-link entry).

**Acceptance criteria:**
- Manifest lists exactly 45 routes (1 + 2 legal + 1 wizard entry + 1 index + 40 community).
- Build fails if `/r/{token}`-pattern output appears in dist (blocklist test).
- Adding a new public route without updating the manifest fails CI with an
  actionable message.

**Dependencies:** SEO-002, SEO-008
**Size:** S

---

### SEO-011 — Static marketing pages (`/how-it-works`, `/pricing`, `/faq`)
**Description:** Prerendered pages promised in BUILD_PLAN but with no owning
story (USER_VALIDATION.md P1-14): `/how-it-works` (3-step: address → preview →
verified report; honest data-disclosure section), `/pricing` (embed flat vs
1% plans for builders; marketplace "coming soon" — no consumer pricing
promises), `/faq` (FAQPage schema.org; includes accuracy-honesty Q&A — no
public ± figure). All get per-page title/meta/OG, canonicals, and llms.txt
entries.

**Acceptance criteria:**
- Three routes in the prerender manifest (manifest count updated from 45).
- `/faq` emits valid FAQPage JSON-LD (schema.org validator test).
- Copy reviewed against the "no public accuracy promise" rule (grep CI for
  accuracy % claims on these pages).

**Dependencies:** SEO-002, SEO-010
**Size:** S

---

### SEO-012 — Labelled sample report page (`/sample-report`)
**Description:** Fictional, clearly-labelled sample report (watermarked
"SAMPLE — fictional address", robots `noindex`) linked from the landing
(UX_FLOW Q4 — sample builds trust pre-gate). Figures rendered from a fixture
estimate so the layout is production-identical.

**Acceptance criteria:**
- Every figure on the page is fixture-derived (contract test pins fixture).
- Visible "SAMPLE" labelling in header, footer, and OG title; `noindex`.
- No real addresses or real assessed values anywhere on the page.

**Dependencies:** SEO-002; fixture from ENG-002.
**Size:** S
**NEEDS-KARAN:** Q4 — sample report on landing: yes (recommended) or no.

---

### SEO-013 — Scheduled `community-stats` refresh (monthly timer)
**Description:** The `community_stats` table has no writer (USER_VALIDATION.md
P1-15): monthly timer Function recomputes per-community aggregates from the
City dataset cache (`properties` refresh) — medians, counts, refreshed_at —
so community pages never go silently stale. Writes `community_stats` +
updates the aggregates JSON consumed by the SEO pipeline.

**Acceptance criteria:**
- Timer runs monthly (NCRONTAB `0 0 1 * *`); recompute is idempotent and
  skips communities with insufficient fresh data (logged, not zero-filled).
- `refreshed_at` < 45 days asserted by a CI staleness check (fails loudly
  if the timer hasn't run).

**Dependencies:** SEO-001 (aggregates pipeline); PRD-003 (dataset refresh).
**Size:** S

---

## Assumptions log

---

## Assumptions log

1. `SITE_URL` (e.g. `https://feasly.com`) comes from a build-time environment
   variable; until the domain is confirmed **(NEEDS-KARAN: feasly.com check)**,
   staging builds use the SWA default hostname. No URL is hardcoded per environment.
2. Community slugs derive from official City community names; if two names
   collide after kebab-casing, the script appends the quadrant (`-nw` etc.) and
   logs it.
3. Top-40-by-record-count is the launch set; the number is a config flag, not code.
4. Build-time engine use (SEO-002) is acceptable: the script runs in CI with
   access to the frozen version's public ranges only — it never sees per_sqft
   (it calls a `publicRangesForCommunity()` helper that takes precomputed
   land/build/total ranges as inputs, not params). This keeps the "params never
   leave the server" rule intact even at build time.
5. `og-default.png` is a static branded asset; per-community OG images are
   deferred (default image used everywhere at launch).
6. Wizard steps are `noindex` (funnel, not content) — deliberate; only landing,
   legal, and community pages compete in search.

## Open questions

- **Q-SEO-1 (NEEDS-KARAN):** feasly.com availability / fallback domain — `SITE_URL`
  and all canonicals/OG URLs depend on it.
- **Q-SEO-2 (NEEDS-KARAN):** Public contact phone/address for LocalBusiness
  JSON-LD — provide or confirm omission.
- **Q-SEO-3:** Is top-40 the right launch count, or start smaller (e.g. 15) for
  tighter quality control? Current call: 40 — programmatic pages are cheap and
  uniform; quality risk is low since every figure is engine-derived. Logged.
- **Q-SEO-4:** Per-community OG images (e.g. community name rendered on branded
  template) — nice for social sharing; deferred to post-launch unless Karan
  wants them day one. Current call: deferred; logged.
- **Q-SEO-5:** Should `/communities/` index also be reachable from the main nav
  (header link) or footer-only? Current call: footer + landing section link;
  header stays conversion-focused (single address CTA). Logged.
