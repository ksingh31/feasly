# FE-6 — SEO & content engine

**Goal:** crawler-, scraper-, and AI-agent-visible from day one. The programmatic
community cost pages are the core content engine; everything else is the technical
SEO that makes them (and the app) rank.

## Stories (build order)

### FE6-001 — SeoService: per-page titles, meta, OG, canonicals
**Size:** S
**Description:** `SeoService` sets `<title>`, meta description, canonical, OG tags,
Twitter cards per route. Indexable: `/`, `/privacy`, `/terms`, `/communities/`,
`/communities/:slug`, `/how-it-works`, `/pricing`, `/faq`. `noindex,nofollow`:
`/estimate/*`, `/preview`, `/check-email`, `/analyzing`, `/r/*`, `/sample-report`.
OG image: branded `assets/og/og-default.png` (1200×630) via absolute URL from
`SITE_URL` (config — never hardcoded; staging uses the SWA hostname until the
domain is confirmed). Default fallback tags for unknown routes.
**Acceptance criteria:**
- Prerendered `/` HTML contains the full tag set (grep test on dist).
- Every noindex route carries the meta tag (assert each).
- `og:image` absolute, from config `SITE_URL`.
**Tests:** spec — tags per route, fallback; UI — n/a (head assertions).
**Mobile:** n/a.
**Config notes:** `SITE_URL` per environment.
**Dependencies:** FE0-004.

### FE6-002 — Community pages: template + index + internal linking
**Size:** M
**Description:** Route `/communities/:slug`, prerendered per community from the mock
aggregates fixture (`slug, name, count, avg_assessed_value, avg_lot_sqft`): H1 "How
much does it cost to build a home in {Community}, Calgary?"; stat block (real
assessed avg, labeled "based on City-assessed values"); build-cost **ranges** for
three tiers computed by calling the frozen engine's *public ranges* helper at build
time (ranges only — per_sqft and margins never touch the content); 5-question FAQ;
CTA "Get your address-specific estimate →". `/communities/` index: card grid of all
communities (name, avg assessed, "from $X" teaser), each linking to its page; every
community page links back to the index + 3 nearby. Count from config
(`COMMUNITY_PAGE_LIMIT`, default 40). Deny-list scan: no per_sqft/margins in output.
**Acceptance criteria:**
- All N pages prerender (assert N HTML files); each `<title>` unique and matching
  `"Cost to Build a Home in {Name}, Calgary | Feasly"`.
- Deny-list scan passes on every page.
- Link integrity: every card href resolves to a file in dist; every community page
  has ≥4 internal links; zero orphans.
- FAQ copy: no accuracy guarantees, no sold-price claims (copy-lint).
**Tests:** spec — slug uniqueness/kebab-case, reproducibility (figures recompute from
fixture + engine version); UI — page + index layout.
**Mobile:** stat blocks stack; cards ≥44px targets; index grid 1-column at 390px.
**Config notes:** page limit, FAQ copy, CTA copy from config.
**Dependencies:** FE6-001, FE0-001 (contracts for aggregates).

### FE6-003 — sitemap.xml, robots.txt, JSON-LD, llms.txt, prerender manifest
**Size:** M
**Description:** Build scripts (run in CI after prerender): `sitemap.xml` (landing,
legal, index, all community pages; `<lastmod>` from aggregates `generated_at`;
`/r/*`, `/estimate/*`, `/preview`, `/check-email`, `/api/` disallowed in
`robots.txt`; `Sitemap:` absolute URL). JSON-LD per page type: community pages get
`FAQPage` (byte-matching rendered FAQ copy — drift test) + `LocalBusiness`
(name "Feasly", areaServed "Calgary, AB", no invented phone/address unless provided).
`llms.txt` (<50KB) + `llms-full.txt` (<500KB) generated from the same content source
(community summaries, how-it-works, FAQs, methodology note, `cost_data_version`);
figures parity-tested against page HTML. Prerender manifest: checked-in explicit
route list; build fails if a manifest route isn't emitted OR an emitted route isn't
in the manifest (bidirectional parity); blocklist asserted (`/r/*`, `/preview`,
`/check-email`, `/analyzing`, `/estimate/scope`, `/estimate/details`).
**Acceptance criteria:**
- Sitemap valid XML; count matches manifest; parity test fails loudly on drift.
- `robots.txt` disallows all private routes.
- JSON-LD: exactly one FAQPage + one LocalBusiness per community page; required
  fields present; FAQ byte-match.
- llms files exist at root, under size caps, figures match pages, version stated.
- Manifest blocklist: no `/r/{token}`-pattern output in dist.
**Tests:** spec — XML validity, parity, drift, deny-list on llms files.
**Mobile:** n/a.
**Config notes:** `SITE_URL`, page limit flow through.
**Dependencies:** FE6-002.
