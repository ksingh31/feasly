# FE-0 — Foundation: contracts, config, mock harness, theme, shell, logo, CI

**Goal:** everything every other epic stands on. Frozen API contracts, the no-hardcode
config system, the mock API harness, the design-system theme, the app shell, the logo,
and the CI gates that enforce the Definition of Done. Nothing here is user-visible
except the shell and logo — but every later story depends on it.

## Stories (build order)

### FE0-001 — Frozen API contracts (`packages/contracts`)
**Size:** M
**Description:** Define every request/response interface the UI will ever need, as
TypeScript types in `packages/contracts`: `PropertyRecord`, `AutocompleteSuggestion`,
`EstimateRequest`, `EstimateResponse` (figures as ranges; `{ blurred: true }`
placeholder variant), `LeadRequest`, `LeadResponse`, `MagicLinkVerifyResponse`,
`ReportSnapshot`, `TierRevision`, `CallbackRequest`, `PartnerShareRequest`,
`AnalyticsEvent`, `EmbedTenantConfig`, `CommunityAggregate`, error envelope
`{ code: 'not_found' | 'non_calgary' | 'service_down' | 'multi_unit' | ... }`.
These are shapes only — no logic, no math.
**Acceptance criteria:**
- `packages/contracts` builds; `apps/web` imports types from it (no local duplicates).
- A contract-conformance test asserts the mock harness (FE0-003) returns exactly these shapes.
- Changing a contract later requires a major-version note in the package changelog.
**Tests:** spec — type-level tests + a "no any" lint pass on the package.
**Config notes:** n/a (this *is* the config-adjacent foundation).
**Dependencies:** none.

### FE0-002 — ConfigService: no hardcoded values, ever
**Size:** S
**Description:** `ConfigService` loads `/assets/config/app-config.json` at startup
(`APP_INITIALIZER`; per-environment files swapped by SWA config). Everything variable
lives here: site URL, feature flags (`sampleReport`, `renovationWaitlist`),
wizard defaults (sqft default/min/max), debounce timings, resend cooldown, copy variants,
community page limit, analytics opt-in wording. Components inject `ConfigService` —
never literals.
**Acceptance criteria:**
- `ng serve` with a modified `app-config.json` changes behavior with zero code edits
  (spot-check: sqft default, resend cooldown).
- CI grep fails on hardcoded URLs, copy strings, or magic numbers in `apps/web/src/app`
  (allowlist file for the rare justified exception).
**Tests:** spec — service loads, merges, and exposes typed config; missing-key behavior defined.
**Mobile:** n/a (service-level).
**Dependencies:** FE0-001.

### FE0-003 — Mock API harness (behaves like the live app)
**Size:** M
**Description:** `MockApiService` implements every contract from FE0-001 with fixture
data (a fake Calgary property, canned estimate ranges, fake magic-link flow with a
`?mock-token=` dev shortcut, canned community aggregates). `app.config.ts` picks
`MockApiService` vs `HttpApiService` from config (`useMockApi`). The analyzing beat,
blur behavior, and gate flow all run against mocks exactly as they will against the
real API. Simulated latency (configurable, default 400–900ms) keeps the UX honest.
**Acceptance criteria:**
- Flipping `useMockApi` is the *only* change needed to point at the real backend later.
- Contract-conformance test: every mock response validates against FE0-001 types.
- No mock-only code paths in components — components can't tell which service is wired.
**Tests:** spec — each mock method returns contract-valid fixtures; latency simulator tested.
**Mobile:** n/a.
**Dependencies:** FE0-001, FE0-002.

### FE0-004 — Theme tokens + app shell (header/footer/landmarks)
**Size:** M
**Description:** Design-system tokens as CSS custom properties from the locked prototype
theme: `--canvas: #1C1914`, `--cream: #F7F4EF`, `--brass: #A8761A` (body text uses
darkened `#8A5F14` for contrast), Syne (display) + Instrument Sans (body) via Google
Fonts with `font-display: swap`. App shell: header (logo + "How it works" anchor +
"Community guides" link), footer (Privacy · Terms · Cookie settings), `<main>`
landmark, global focus-visible styles, `prefers-reduced-motion` handling.
**Acceptance criteria:**
- Tokens render: canvas hero, cream body, brass CTAs; Syne on `h1`, Instrument Sans on body.
- Prerendered shell HTML contains header/footer landmarks with zero JS.
- Brass-on-cream restricted to large text; body contrast ≥ 4.5:1 (automated check).
**Tests:** spec — token values snapshot; computed-style test on shell.
**UI/functionality:** visual check of shell on desktop.
**Mobile:** 390px — header collapses to logo + menu affordance; footer stacks; no horizontal scroll.
**Config notes:** font URLs and token overrides come from config (white-label future).
**Dependencies:** FE0-002.

### FE0-005 — Text logo (creative, changeable later)
**Size:** S
**Description:** The Feasly wordmark as a text-based SVG: lowercase `feasly` in Syne
ExtraBold with a brass gradient, a roofline caret floating above the wordmark (the
"home" cue), and a foundation bar under it (the "build" cue). Ships as
`apps/web/src/assets/brand/logo.svg` + a cream monochrome variant for dark surfaces.
Designed to be swapped later without touching layout (fixed viewBox, `currentColor`-able).
**Acceptance criteria:**
- Renders crisply at 24px (favicon-ish) and 120px (header); no raster assets.
- Monochrome variant passes contrast on `--canvas`.
- Used in the shell header and footer (FE0-004 wiring).
**Tests:** spec — SVG well-formed, has `role="img"` + `aria-label`; visual check both variants.
**Mobile:** legible at mobile header size (32px height); tap target ≥44px links to `/`.
**Config notes:** logo path is config-overridable (tenant white-label future).
**Dependencies:** FE0-004.

### FE0-006 — CI gates for the UI workflow
**Size:** M
**Description:** GitHub Actions for `apps/web`: `ng build` + prerender, `ng test`
(headless), ESLint + Prettier, copy-lint (no `±`/`%` accuracy claims; "Unlock" exactly
once repo-wide), no-hardcode grep (FE0-002), axe on prerendered routes, Lighthouse CI
on the SWA PR preview (Performance ≥90, Accessibility ≥95, SEO = 100). All blocking
for `main` via the existing `build` required check (extend it, don't add noise).
**Acceptance criteria:**
- A deliberately introduced `±10%` claim fails copy-lint; a second "Unlock" fails the count check.
- A hardcoded URL literal in a component fails the no-hardcode grep.
- Lighthouse runs against the PR preview URL automatically.
**Tests:** meta — the gates themselves are tested with fixtures (bad copy, bad literal).
**Mobile:** Lighthouse mobile emulation in the gate.
**Dependencies:** FE0-001…FE0-005 (gates cover them).
