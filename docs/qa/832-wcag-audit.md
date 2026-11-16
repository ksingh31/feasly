# #832 — WCAG 2.2 AA audit and iPhone Safari pass

Date: 2026-11-16. Build: production (`ng build --configuration=production`),
served by `apps/web/tools/serve-dist.mjs`, API answered by the
contract-shaped mock (`api.useMockApi`, `propertyData.source: 'mock'`).

## How to re-run

```bash
npm run build --workspace=@feasly/web -- --configuration=production
npx playwright install chromium webkit          # once
E2E_SCREENSHOTS=1 npm run e2e --workspace=@feasly/web
```

| Suite | Routes / steps | Engines | Viewports |
|---|---|---|---|
| `e2e/public-a11y.e2e.ts` (new) | 25 public routes (`e2e/public-a11y-routes.ts`), consumer flow (7 steps), first-visit consent bar, gate focus, keyboard-only walk | Chromium, WebKit (touch + mobile) | 1440×900, 390×844, 375×667 |
| `e2e/builder-no-overflow.e2e.ts` | every builder portal route + lead drawer + invoice drawer | Chromium | 1440×900, 390×844 |
| `e2e/admin-no-overflow.e2e.ts` | every admin portal route | Chromium | 1440×900, 390×844 |

Gate on every page/step: axe `wcag2a, wcag2aa, wcag21a, wcag21aa`
(public suite adds `wcag22aa`), **zero critical/serious**, and no
horizontal overflow. Result on this branch: **251 passed, 1 skipped**
(the keyboard walk is Chromium-only; see below).

## Findings and fixes

| # | Finding | WCAG | Severity | Status |
|---|---|---|---|---|
| 1 | `/guides/calgary-zoning-explained` and `/developers` tables widened the page at 390/375 (horizontal scroll). | 1.4.10 Reflow | serious | **Fixed**: tables sit in a labelled, focusable `.table-scroll` region (`role="region"`, `aria-labelledby`, `tabindex="0"`). Same for the cost guide table. |
| 2 | `/developers` code blocks scroll sideways but couldn't take keyboard focus (axe `scrollable-region-focusable`). | 2.1.1 Keyboard | serious | **Fixed**: `<pre tabindex="0">`. |
| 3 | `/developers` long inline URL in `<code>` overflowed at 375. | 1.4.10 | serious | **Fixed**: `overflow-wrap: anywhere` on inline code. |
| 4 | First visit: the fixed consent bar covered the focused address box (landing, 390/375) and gate fields (all widths). | 2.4.11 Focus Not Obscured | serious | **Fixed**: the bar publishes its height as `--consent-banner-h`; `html { scroll-padding-bottom }` + body padding keep focused fields and the page end clear of it. |
| 5 | Client navigation between steps (landing → scope → preview → gate → report) left focus on `<body>` with no announcement. Screen-reader users weren't told the step changed. | 2.4.3 Focus Order, 4.1.3 | serious (SR) | **Fixed**: `RouteFocusService` focuses the new page's `<main id="main-content" tabindex="-1">` after a path change (not on first load, not for `?open=`/`#` changes, never over a control the page focused). |
| 6 | Report "Adjust the size" − / + changed the value silently. | 4.1.3 Status Messages | moderate | **Fixed**: value is `role="status"`. |
| 7 | Living-area slider read as "2200" (no unit). | 1.3.1 | minor | **Fixed**: `aria-valuetext="2,200 sq ft"`. |
| 8 | Report `<details>` (phone layout) disclosure glyph `▶` came from CSS `content` and could be read as "black right-pointing triangle". | 1.1.1 | minor | **Fixed**: `content: '▶' / ''` (empty alt text). |
| 9 | Option-card radio groups put every option in the Tab order (~11 stops on scope). | APG pattern (not a WCAG failure) | minor | Filed #937. |
| 10 | Scope step: property card `h2` precedes the page `h1`. | 1.3.1 / best practice | minor | Filed #938. |

No critical/serious axe violations remain on any route (AC1).

## Screen-reader walkthrough (AC2)

**Method.** No screen reader runs on the Linux CI agent, so this walkthrough
used the browser accessibility tree (Playwright `ariaSnapshot`, which
is what VoiceOver/NVDA consume) plus a keyboard-only Tab walk, at each step
of the consumer flow. The pass on real VoiceOver (iOS + macOS) and NVDA
needs Apple/Windows hardware and a person: tracked in #939.

| Step | What a screen reader gets | Notes |
|---|---|---|
| Landing | Skip link → "Feasly home" link → Menu button → `main`. `h1` "What will it really cost to build your home in Calgary?". Address `form "Address search"` with `combobox "Search an address or community"`; typing opens `listbox` with grouped `option`s ("1234 14 St NW, Calgary, AB Capitol Hill"). ArrowDown + Enter picks an address. | Good. Combobox exposes expanded state and options. |
| Scope | Focus moves to `main` (fix 5). "← Back to address" link, `list "Estimate progress"` (current step `aria-current="step"`), property `article`, `h1` "Configure your build scope", labelled `radiogroup`s (project type, finish tier, garage, basement) with checked state, `slider "Living area"` now read with its unit (fix 7), "See My Preview →" button. | Heading order (#938) and per-option Tab stops (#937) filed. |
| Preview | Focus moves to `main`. `h1` "Your estimate preview", `region "Locked estimate figures"` with "Total investment" / "Build cost" headings and "Revealed when you get your free report.", the single "Unlock my free report →" link, property card. | Figures behind the blur are not exposed as text in the tree (the nudge copy is). |
| Gate | Focus moves to `main`. `h1` "Where should we send your estimate?"; labelled `textbox`es (Full name, Email address, Phone (optional)), `combobox "When are you hoping to build?"` (native select), consent `checkbox` with its full label, "Show my report →" button. Honeypot is `aria-hidden` and `tabindex="-1"` (skipped by Tab — asserted). Submitting empty marks each field `[invalid]` and each message is `role="alert"`, tied by `aria-describedby`. | Good. |
| Report | `h1` "Your build estimate", figures as text, `region`s for budget breakdown, "Adjust your estimate" (size stepper now announces changes, fix 6; tier `radiogroup`), callback form with labelled fields, share/download, data link. | Good after fixes 6 and 8. |

**Keyboard-only walk** (Chromium, asserted in `public-a11y.e2e.ts`):
Tab reaches the address combobox; ArrowDown/Enter selects; on each new step
focus is on `main`, Tab reaches the radio, Space checks it, Tab/Enter
continues, the gate is completed and submitted by keyboard alone. WebKit
only Tabs to links/buttons with macOS "full keyboard access" on, so the
walk is skipped there; WebKit gets the axe, overflow and focus-obscured
checks.

## iPhone Safari pass (AC3)

**Method.** Playwright WebKit (the Safari engine) with touch + mobile
viewport, at 390×844 (iPhone 15/14) and 375×667 (iPhone SE). The iOS
Simulator needs macOS: tracked in #939.

Checked:
- **Sticky/fixed elements**: site nav (fixed top) and first-visit consent
  bar (fixed bottom). Every gate field, the scope CTA and the unlock link
  are asserted not to be under a fixed element when focused, with and
  without the consent bar (fix 4).
- **Keyboard overlap on forms**: the gate fields scroll clear of the
  consent bar (fix 4). The on-screen keyboard itself can only be checked in
  the Simulator / on a device (#939).
- **Date/time inputs**: none in public flows. The only date input
  (`shared/ui/fields/date-field`) is in the admin portal and uses the
  native `type="date"` picker. The gate timeline is a native `<select>`
  (iOS wheel picker).
- **Safe areas**: `index.html` does not set `viewport-fit=cover`, so Safari
  keeps content inside the safe area (notch, home indicator); the
  `env(safe-area-inset-*)` paddings in drawers/sheets fall back to 0.

Screenshots (WebKit, viewport capture) in [`docs/qa/832/`](832/):

| Step | 390×844 | 375×667 |
|---|---|---|
| 1 Landing + autocomplete | `flow-1-landing-autocomplete-390.png` | `flow-1-landing-autocomplete-375.png` |
| 2 Scope | `flow-2-scope-390.png` | `flow-2-scope-375.png` |
| 3 Scope, New Build chosen | `flow-3-scope-selected-390.png` | `flow-3-scope-selected-375.png` |
| 4 Preview | `flow-4-preview-390.png` | `flow-4-preview-375.png` |
| 5 Gate | `flow-5-gate-390.png` | `flow-5-gate-375.png` |
| 6 Gate errors | `flow-6-gate-errors-390.png` | `flow-6-gate-errors-375.png` |
| 7 Report | `flow-7-report-390.png` | `flow-7-report-375.png` |
| First visit, consent bar | — | `first-visit-landing-375.png` |
| Embed (white-label) | `public-embed-390.png` | — |
| Sample report | `public-sample-report-390.png` | — |

## Manual pass

To be filled in by #939 (VoiceOver iOS/macOS, NVDA, iOS Simulator Safari).
