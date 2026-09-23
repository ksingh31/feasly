# FE-1 — Landing & marketing pages (S0 + content)

**Goal:** the front door and the trust-building pages. S0 has one job — get the
address. Marketing pages answer "how does this work / what does it cost / is it legit"
before the user ever types an address. All prerendered, all SEO-complete.

## Stories (build order)

### FE1-001 — S0 landing: hero + address entry (the one job)
**Size:** M
**Description:** `/` — Hero "What will it really cost to build your home in Calgary?",
address input with autocomplete (3+ chars, 250ms debounce from config, max 6
suggestions, keyboard navigable). Selecting a suggestion routes to S2 with the
property pre-loaded (skips S1). Mock contract: `AutocompleteSuggestion[]` →
`PropertyRecord`.
**Acceptance criteria:**
- Typing 3+ chars fires debounced mock search; Enter/click selects → `/estimate/scope`
  with wizard state populated at step 2.
- Empty-submit and no-result states have designed copy (no dead ends).
- Hero copy present in prerendered HTML (curl + grep, no JS).
**Tests:** spec — debounce, keyboard nav, routing; UI — hero renders per design.
**Mobile:** single column, sticky CTA visible at 390×844 without scrolling; autocomplete
usable with mobile keyboard (no viewport zoom trap — input font-size ≥16px).
**Config notes:** hero copy, debounce ms, suggestion limit from `ConfigService`.
**Dependencies:** FE0-001…FE0-004.

### FE1-002 — Trust strip + How-it-works + footer conversion paths
**Size:** S
**Description:** Trust strip with NO accuracy figure ("Range-based estimates ·
Real City of Calgary data · AI cost breakdown"); "How it works" 3-step section
(address → preview → verified report); community-guides teaser linking to
`/communities/`; sample-report slot behind `features.sampleReport` flag (slot
vanishes — not a dead link — if off).
**Acceptance criteria:**
- Copy-lint: no `±`, `%`, or accuracy claim anywhere in the strip.
- Sample slot fully absent when flag off (DOM assertion).
- Community teaser links to `/communities/`.
**Tests:** spec — flag on/off rendering; UI — section layout desktop.
**Mobile:** strip wraps to 2 lines max; steps stack vertically; CTA thumb-reachable.
**Config notes:** all strip/section copy from config.
**Dependencies:** FE1-001.

### FE1-003 — Marketing pages: /how-it-works, /pricing, /faq
**Size:** M
**Description:** Prerendered trio. `/how-it-works`: 3 steps + honest data-disclosure
section (what the numbers are based on). `/pricing`: builder embed plans (flat vs
1% — copy from config, no consumer pricing promises). `/faq`: FAQPage JSON-LD,
includes the accuracy-honesty Q&A ("Why don't you show a ± figure?"). Each with
per-page title/meta/OG/canonical via `SeoService`.
**Acceptance criteria:**
- All three in the prerender manifest; `<title>` unique per page.
- `/faq` emits valid FAQPage JSON-LD; answers byte-match rendered copy.
- Copy-lint: no accuracy promises on any of the three.
**Tests:** spec — SeoService tags per route; UI — pages render.
**Mobile:** 390px readable, no horizontal scroll, accordions (FAQ) thumb-friendly.
**Config notes:** pricing tiers/figures from config — never in templates.
**Dependencies:** FE1-001, FE6-001 (SeoService — build the service here if FE-6 lags;
note the dependency inversion in the PR).

### FE1-004 — /privacy + /terms (launch-blocker copy, draft-marked)
**Size:** S
**Description:** Prerendered, footer-linked sitewide. Cover: data collected, magic-link
bearer semantics (forwarding = access), City-data attribution, not-an-appraisal
disclaimer, CASL wording, contact. Ships with a `LEGAL_REVIEW_PENDING` staging banner;
production build fails while the flag is true (lawyer sign-off flips it).
**Acceptance criteria:**
- All six coverage items present (heading checklist test).
- Staging shows the draft banner; prod build with flag true fails CI.
- Footer links reach both pages from every route.
**Tests:** spec — coverage checklist; UI — banner visibility per environment.
**Mobile:** long-form readable (line-length, spacing); banner doesn't cover content.
**Config notes:** `legalReviewPending` flag from config/env.
**Dependencies:** FE1-001.

### FE1-005 — /404 + /sample-report
**Size:** S
**Description:** Branded 404 (canvas background, "That page doesn't exist." + CTA home,
real 404 status via SWA config). `/sample-report`: fictional, watermarked "SAMPLE —
fictional address", `noindex`, figures from a pinned fixture so layout is
production-identical; every figure fixture-derived (contract test pins it).
**Acceptance criteria:**
- Unknown path → branded 404 with HTTP 404.
- Sample page: "SAMPLE" in header, footer, OG title; zero real addresses/values.
- Linked from landing only when `features.sampleReport` is on (FE1-002 slot).
**Tests:** spec — fixture pinning; UI — watermark visible.
**Mobile:** report layout reflows to single column at 390px.
**Config notes:** fixture id + flag from config.
**Dependencies:** FE1-001, FE1-002.
