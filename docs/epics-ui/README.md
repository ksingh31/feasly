# Feasly UI-First Build Plan — Epics & Stories

**Status:** approved by Karan 2026-09-23. **Approach:** contracts → frontend with mocks → backend.

## The deal

1. **Contracts first (FE-0).** Frozen TypeScript interfaces in `packages/contracts` — the
   shapes of every API request/response. No logic, no database, just the seam.
2. **Frontend, screen by screen, following the UX flow** (S0 → S8 + marketing + SEO +
   embed). Every screen is built against the frozen contracts with a mock API layer that
   behaves like the live app. No cost math, no proprietary logic in the client — ever.
3. **Backend later** satisfies the frozen contracts. Swapping mocks → real HTTP is a
   provider swap per service. Zero UI rework by design.

**Why this order (teammate's take):** the classic frontend-first trap is mocks drifting
from what the backend will actually return, turning "the swap" into a rewrite. Freezing
contracts first kills that risk. The UI can never see sensitive logic because the
contract only carries what the real API would return — blurred placeholders pre-gate,
real figures post-gate.

**Source of truth for screens:** `~/workspace/feasly/plan/UX_FLOW.md` (S0–S13) and the
locked UX decisions (single lead gate, blur-until-verified, "Unlock" appears once,
CASL unchecked by default, etc.). These UI epics re-sequence the existing plan
(`docs/plan/epics/03-consumer-web.md`, `04-seo-publishing.md`) frontend-first; they do
not change the screen requirements.

## Epic map (follows the user flow)

| Epic | Screens | Focus |
|---|---|---|
| [FE-0](FE-0-foundation.md) | — | Contracts, config, mock harness, theme, shell, logo, CI gates |
| [FE-1](FE-1-landing-marketing.md) | S0 + marketing | Landing, how-it-works, pricing, FAQ, privacy, terms, 404, sample report |
| [FE-2](FE-2-wizard.md) | S1–S3 | Estimate wizard: address, scope, details |
| [FE-3](FE-3-analyzing-preview.md) | S4–S5 | Analyzing beat + blurred preview |
| [FE-4](FE-4-gate-magiclink.md) | S6–S7, /r/{token} | Lead gate, check-email, magic-link verify |
| [FE-5](FE-5-report.md) | S8 | Full report, what-if, re-run, next steps, callback, share, PDF |
| [FE-6](FE-6-seo-content.md) | — | SEO: community pages, sitemap, JSON-LD, llms.txt, prerender |
| [FE-7](FE-7-embed.md) | embed | Builder embed shell, theme handshake, tenant config |
| [FE-8](FE-8-a11y-mobile.md) | all | Accessibility + mobile hardening pass |

**32 stories total.** Each epic file lists its stories in build order with dependencies.

## Non-negotiable rules (every story)

- **No hardcoded values.** All copy variants, URLs, limits, feature flags, and magic
  numbers flow through `ConfigService` (`/assets/config/app-config.json`, per-environment
  via SWA config). A CI grep fails the PR on literals in components (copy, URLs, numbers).
- **No logic in the frontend.** The client renders what the API returns. Figures arrive as
  `{ blurred: true }` placeholders pre-gate — real numbers are never in the DOM,
  view-source, or prerendered HTML.
- **Mock = contract-shaped.** `MockApiService` implements the frozen contracts with
  fixture data. Provider swap in `app.config.ts` (`useMockApi` from config).
- **PR per story.** Branch `feat/<story-id>-<slug>` → PR → green CI → merge to `main`.
  Branch protection enforces it; 0-approval rule is deliberate (solo account).
- **Tests before merge, every story:** unit specs (`*.spec.ts`), UI + functionality test
  against mocks, and a mobile pass (390×844: no horizontal scroll, ≥44px touch targets,
  sticky CTAs never cover inputs).

## Global Definition of Done (applies to every story)

- [ ] Unit specs pass (components, services, pipes, guards)
- [ ] UI test: renders per acceptance criteria on desktop viewport
- [ ] Functionality test: every interaction works end-to-end against the mock API
- [ ] Mobile test: 390×844 — no horizontal scroll, touch targets ≥44px, sticky CTAs clear of inputs, autocomplete usable with mobile keyboard
- [ ] A11y: keyboard-only path works, focus management correct, axe zero critical/serious
- [ ] No hardcoded values (config or justified constants file; CI grep passes)
- [ ] SEO: public routes prerendered with title/meta/OG/canonical; private routes `noindex`
- [ ] Copy-lint: no accuracy claims (±, %), "Unlock" appears exactly once repo-wide
- [ ] Lighthouse on touched routes: Performance ≥90, Accessibility ≥95, SEO = 100

## Story format

Each story has: **ID / Title / Size / Description / Mock contract / Acceptance criteria /
Tests (spec · UI/functionality · mobile) / Config notes / Dependencies.**
"Tests" spells out what to verify, not just "write tests" — the PR doesn't merge until
each box is checked.
