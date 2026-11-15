# SEO + AI-answer (GEO) page standard

**Owner decision (2026-11-15):** ranking at the top of Google, and being the source that answer engines cite (ChatGPT, Gemini / AI Overviews, Perplexity, Copilot, Claude), is a priority. **Every public page we build or change must meet this standard. A public page without it is not done.** Private and funnel routes stay `noindex`; only the first checklist row applies to them.

This complements the DoD in `docs/epics-ui/README.md`, the SEO epic `docs/plan/epics/04-seo-publishing.md` and the copy rules in `CLAUDE.md`. Where they conflict, copy and legal rules win. SEO never justifies an accuracy claim, "guarantee", "appraisal" or "market value".

## 1. Technical checklist (every indexable route)

| # | Requirement | Where it lives |
|---|---|---|
| 1 | Route registered in the SEO table: indexable routes have no `noindex`; private routes `noindex: true` | `apps/web/src/app/core/seo/seo-routes.ts` (data-driven pages use `SeoService.setPage()`) |
| 2 | **Prerendered** HTML; content visible without JS | Angular prerender route manifest |
| 3 | **Unique `<title>`**, ≤ 60 chars, primary query first, then "· Feasly" | config `copy.seo.*Title` (never literals) |
| 4 | **Unique meta description**, 120–160 chars, states the answer, not a teaser | config `copy.seo.*` |
| 5 | Self-referencing **canonical** with a trailing slash | `SeoService` |
| 6 | OG + Twitter tags (`og:title/description/url/image/type`, `summary_large_image`) | `SeoService` |
| 7 | **JSON-LD** matching the page type (`Article`, `FAQPage`, `Dataset`, `BreadcrumbList`, `Organization`/`WebSite` on home). Every FAQ question and answer must also appear **verbatim in the visible page** | `core/seo/jsonld-schemas.ts` |
| 8 | Listed in **`sitemap.xml`** with sensible `changefreq` / `priority` | `apps/web/scripts/build-seo-artifacts.ts` |
| 9 | Listed in **`llms.txt`**: one line with the URL and a one-sentence factual summary (guides, community pages, how-it-works, FAQ, developers) | `apps/web/scripts/build-llms-txt.ts` |
| 10 | Covered by the **prerender SEO CI check**: full tag set, canonical, not noindexed, JSON-LD valid and mirroring the visible copy | `apps/web/tools/check-prerender-seo.mjs` |
| 11 | **Lighthouse SEO = 100**, Performance ≥ 90, Accessibility ≥ 95 on the route | `lighthouse.yml` |
| 12 | Exactly **one `<h1>`**; logical `h2`/`h3` outline; descriptive link text (never "click here"); `alt` on meaningful images | component template |
| 13 | **Internal links:** linked from at least one indexable page (index, hub or nav), and links out to ≥ 2 related pages (guide ↔ community ↔ estimator) | component template |
| 14 | URL: lowercase kebab-case, stable, no query strings for content, trailing slash | routes + SWA config |

## 2. Content checklist (Google + LLM answers)

Answer engines lift short, self-contained, well-sourced passages. Write so that any one section can be quoted on its own and still be correct.

1. **Answer first.** Open with a 40–60-word direct answer to the page's main question, including the range and its basis ("based on City of Calgary assessed data"). Detail comes after.
2. **One page, one intent.** Each page targets one primary query and its close variants (see the keyword groups in `docs/marketing/2026-11-marketing-plan.md` §1.2). Don't create near-duplicate pages; consolidate them instead.
3. **Question-shaped headings** that mirror real searches ("How much does it cost to build an infill in Altadore?"), each answered in its first sentence.
4. **Tables for numbers.** Ranges by finish tier or community go in HTML tables, not prose or images. Every dollar figure comes from `packages/cost-engine` (public ranges only), and the page shows the cost-data version.
5. **Entities and facts, stated consistently.** Use the same wording for what Feasly is (a planning-range estimator, not a quote or appraisal), for the data source (City-assessed values) and for the coverage area (Calgary), everywhere: page, llms.txt and JSON-LD.
6. **Freshness signals.** Show a visible "Updated <date>" and keep `dateModified` in the `Article` JSON-LD. Re-review any page that mentions zoning or policy when rules change (e.g. the 2026-08-04 rezoning repeal).
7. **Cite primary sources** (City of Calgary pages, bylaws, open-data datasets) with links. Engines favour pages that cite authorities, and so do readers.
8. **Original data beats summaries.** Community aggregates, the Cost Index and methodology notes are content nobody else has. Lead with them.
9. **Depth without padding.** Pillar guides run ~1,200–2,500 words; community pages need unique per-community facts, not template swaps. Thin or duplicated pages get `noindex` or get merged.
10. **FAQ block** of 4–8 real questions on guides and community pages, mirrored in `FAQPage` JSON-LD.
11. **A clear next step.** Each content page links to the estimator, pre-filled with the community where possible. Use the approved copy; "Unlock" appears exactly once, repo-wide.

## 3. AI crawlers and indexing

- `robots.txt` allows all crawlers (`User-agent: * / Allow: /`), including OAI-SearchBot, GPTBot, PerplexityBot, ClaudeBot, Google-Extended and Bingbot. Don't add blocks without an owner decision.
- Register the production domain in **Google Search Console** and **Bing Webmaster Tools** (Copilot and ChatGPT search lean on Bing's index), and submit the sitemap to both. Enable **IndexNow** on deploy.
- `llms.txt` / `llms-full.txt` are generated at build from the same sources as the pages. Never hand-edit them.

## 4. Measuring it

- **Google:** Search Console impressions, clicks and average position for each guide and community page, reviewed monthly.
- **AI answers:** a fixed panel of ~20 prompts run monthly across ChatGPT, Perplexity, Gemini / AI Overviews, Copilot and Claude. Log whether Feasly is cited and which URL. Tag AI referrers (chatgpt.com, perplexity.ai, gemini.google.com, copilot.microsoft.com, claude.ai) in analytics.

## 5. Review gates

- **architect:** every story that adds or changes a public page lists the checklist rows it touches in its acceptance criteria.
- **frontend-dev:** a PR adding a public route updates the SEO table, sitemap, llms.txt and the prerender check in the same PR.
- **pr-reviewer / ux-reviewer:** flag any public route missing a §1 row, or content that misses §2 items 1–5.

## Known gaps (2026-11-15)

Found while writing this standard; to be fixed in follow-up stories:

1. `check-prerender-seo.mjs` keeps a **hand-written route list**, and `/guides/calgary-zoning-explained/` is not on it, although it is in the SEO table and the sitemap. Derive the list from `seo-routes.ts` (all non-`noindex` patterns without params) so new pages can't skip the check.
2. `llms.txt` does not list the guides (`/guides/cost-to-build-a-house-calgary/`, `/guides/calgary-zoning-explained/`).
3. Community pages cover the top 40 communities by record count, which are mostly suburban. None of the established infill communities (Altadore, South Calgary/Marda Loop, Killarney-Glengarry, Mount Pleasant, …) has a page. See marketing plan §3.
4. Community aggregates include non-residential parcels, which produces outliers such as Downtown Commercial Core at ~$5.4M average assessed. Restrict them to residential parcels.
5. The cost-data version string reads `unclibrated`, a typo for "uncalibrated", in llms.txt.
