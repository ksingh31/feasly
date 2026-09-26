# Performance baselines (SEO-08)

Budgets: `apps/web/budgets.json` (single source of truth). Gate: `.github/workflows/lighthouse.yml`.

## Static bundle metrics (measured locally, production build)

Recorded 2026-09-26 on `origin/main` at #125 (`a7f9a21`) — re-measured after rebase onto latest main:

| Metric | Measured | Budget | Headroom |
|---|---|---|---|
| Initial JS (gzipped) | 176.78 KB | 200 KB | 23.2 KB |
| Initial JS (raw, Angular `initial` budget) | 664 KB | 750 KB (error) / 700 KB (warn) | 86 KB to error |
| Heaviest page image weight | < 1 KB (no `<img>` on prerendered pages) | 500 KB/page | full |

Reproduce: `npm run build --workspace @feasly/web -- --configuration=production && node apps/web/tools/check-perf-budgets.mjs`

## Lighthouse score baselines

Audit set (deterministic, from `node apps/web/tools/perf-audit-urls.mjs`):

- `/`, `/how-it-works`, `/faq`, `/communities`
- `/communities/arbour-lake`, `/communities/auburn-bay`, `/communities/beddington-heights`
  (first 3 alphabetically)

Lighthouse scores are recorded by the `lighthouse` CI job (LHCI uploads results as the
`lhci-results` artifact on every PR). No Chrome was available in the build environment where
this file was written, so score baselines below are filled in from the first green
`lighthouse` run on `main` — copy the median-run category scores per URL into this table then.

| URL | Performance | Accessibility | Best practices | SEO | LCP | CLS | TBT |
|---|---|---|---|---|---|---|---|
| `/` | — | — | — | — | — | — | — |
| `/how-it-works` | — | — | — | — | — | — | — |
| `/faq` | — | — | — | — | — | — | — |
| `/communities` | — | — | — | — | — | — | — |
| `/communities/arbour-lake` | — | — | — | — | — | — | — |
| `/communities/auburn-bay` | — | — | — | — | — | — | — |
| `/communities/beddington-heights` | — | — | — | — | — | — | — |

Thresholds (must stay green): Performance ≥ 90, Accessibility ≥ 95, Best practices ≥ 90,
SEO = 100, LCP ≤ 2.5 s, CLS ≤ 0.1, TBT ≤ 200 ms.
