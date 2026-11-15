# Feasly Design Tokens — Typography & Color System

**Approved by Karan 2026-09-24** (mockup `feasly-font-demotion-mockup`, rev 3).
This is the single source of truth. Every new component, story, and mockup
must use these tokens — no local font stacks, no one-off hex values, no
copy-paste type styles.

## Font roles

| Token            | Font           | Use ONLY for                                                  |
|------------------|----------------|---------------------------------------------------------------|
| `--font-wordmark`| Syne           | The Feasly wordmark/logo. **Nowhere else.**                    |
| `--font-headline`| Manrope        | Hero headlines and major marketing headings (landing hero,    |
|                  |                | "How it works" section title, marketing section headers).     |
| `--font-ui`      | Instrument Sans| EVERYTHING else: form labels, wizard steps, report UI,        |
|                  |                | property cards, body copy, product numbers, legal pages,      |
|                  |                | trust strip, step titles.                                     |

**Why Syne is demoted:** Karan rejected Syne's lowercase "g" on headlines.
That flat-terminal "g" is Syne Bold's natural letterform (verified by
rendering the isolated glyph from the Google Fonts latin subset, 2026-09-24)
— not a CSS bug, so no `line-height` or `overflow` fix can ever change it.
Syne survives only on the wordmark, where the flat "g" is a brand mark, not
a bug report.

Fonts load from Google Fonts in `apps/web/src/index.html` (preconnect +
one CSS2 request with all three families). Never `@import` fonts in a
component stylesheet.

## Type scale

| Token               | Value                    | Used for                                        |
|---------------------|--------------------------|-------------------------------------------------|
| `--type-hero`       | `clamp(34px, 5vw, 64px)` | Hero headline. Stays huge. `text-wrap: balance`.|
| `--type-hero-sub`   | `clamp(18px, 2vw, 22px)` | Hero subhead under the headline.                |
| `--type-section-body`| `18px`                  | Section intro copy (e.g. "How it works" sub).    |
| `--type-step-body`  | `17px`                   | Step/feature descriptions.                      |
| `--type-eyebrow`    | `13px`                   | Eyebrow labels ("How it works", card tags):     |
|                     |                          | uppercase + letter-spacing (0.14em on landing,  |
|                     |                          | 0.05–0.08em on card tags) + brass color.        |

Rules of thumb: marketing headings are Manrope 700 with tight tracking
(`-0.025em` to `-0.03em`); product/UI headings are Instrument Sans 600;
body line-height 1.65–1.7; buttons 15–16px semibold.

## Color palette

| Token          | Value                | Use for                                     |
|----------------|----------------------|---------------------------------------------|
| `--cream`      | `#f7f4ef`            | Default page background (warm cream).       |
| `--cream-2`    | `#f0ece4`            | Alt section background (e.g. "How it works").|
| `--card`       | `#ffffff`            | Cards.                                      |
| `--canvas`     | `#1c1914`            | Dark surfaces (nav, trust strip, primary CTA).|
| `--canvas-2`   | `#242018`            | Dark surface variant.                       |
| `--text`       | `#1a1612`            | Headings & primary text (charcoal).         |
| `--muted`      | `#6b5f53`            | Secondary text. Darkened from `#7a6e62` (4.2:1 on `--cream-2`) to clear 4.5:1 on every light surface. Never lower it with `opacity`. |
| `--on-dark`    | `#ede9e2`            | Text on dark surfaces.                      |
| `--on-dark-muted` | `#8c8278`         | Secondary text on dark.                     |
| `--accent`     | `#a8761a`            | Brass **fills, rules, borders, focus** only. As text it is 3.6:1 on cream — fails AA. |
| `--accent-text`| `#8a5f12`            | Brass **text** on light surfaces (eyebrows, links, step numbers, `.code`): ≥ 4.5:1 on `--cream`, `--cream-2`, `--card`. |
| `--accent-deep`| `#6e5410`            | Solid brass background behind white text (white on `--accent` is 3.98:1). |
| `--accent-dark`| `#c49235`            | Brass on dark surfaces.                     |
| `--accent-bg`  | `rgba(168,118,26,.08)` | Brass wash behind badges.                  |
| `--border`     | `rgba(26,22,18,.1)`  | Hairline borders on cream.                  |
| `--danger`     | `#b3261e`            | Errors.                                     |
| `--focus-ring` | `rgba(168,118,26,.35)` | Focus outlines.                           |

Karan prefers this warm cream/charcoal/brass direction over the older live
site look — when in doubt, lean warmer and roomier, not flatter and greyer.

Primary CTA on cream is charcoal (`--canvas` background, `--on-dark` text).
Never put white text on `--accent`.

## Product tokens (portals) — added 2026-11-15, issue #493

Spec: [`docs/design/portal-ui-kit.md` §1](design/portal-ui-kit.md). Builder
and admin pages are built only from these plus the palette above.

### Status tones (chips, banners, KPI borders)

Pair each `-bg` with its `-fg`; every pair is ≥ 4.5:1.

| Tone       | Background token              | Foreground token              |
|------------|-------------------------------|-------------------------------|
| neutral    | `--status-neutral-bg` `#efebe4`  | `--status-neutral-fg` `#4a4239`  |
| info       | `--status-info-bg` `#e6eef9`     | `--status-info-fg` `#1f4f8f`     |
| progress   | `--status-progress-bg` `#f3ead8` | `--status-progress-fg` `#7a5410` |
| success    | `--status-success-bg` `#e3f2ea`  | `--status-success-fg` `#1c6b44`  |
| warning    | `--status-warning-bg` `#fbefd9`  | `--status-warning-fg` `#8a4b06`  |
| danger     | `--status-danger-bg` `#fbe7e5`   | `--status-danger-fg` `#9b2018`   |
| paused     | `--status-paused-bg` `#ede8f5`   | `--status-paused-fg` `#5a3f8c`   |

### Spacing (4px base)

| `--space-1` | `--space-2` | `--space-3` | `--space-4` | `--space-5` | `--space-6` | `--space-7` | `--space-8` |
|---|---|---|---|---|---|---|---|
| 4px | 8px | 12px | 16px | 24px | 32px | 48px | 64px |

### Radius, elevation, layers

| Token              | Value                              | Use for                          |
|--------------------|------------------------------------|----------------------------------|
| `--radius-sm`      | `6px`                              | Inputs, small buttons.           |
| `--radius-md`      | `10px`                             | Cards, banners.                  |
| `--radius-lg`      | `14px`                             | Drawers, modals.                 |
| `--radius-pill`    | `999px`                            | Chips, pill buttons.             |
| `--shadow-overlay` | `0 12px 40px rgba(28, 25, 20, .18)`| Drawers, modals, menus.          |
| `--scrim`          | `rgba(28, 25, 20, .32)`            | Backdrop behind drawers/modals.  |
| `--z-sticky`       | `10`                               | Sticky headers/footers.          |
| `--z-drawer`       | `40`                               | Drawers.                         |
| `--z-modal`        | `50`                               | Modals (stack over a drawer).    |
| `--z-toast`        | `60`                               | Toasts (above everything).       |

### Product type scale

`font` shorthands, all `--font-ui` (never `--font-headline`). Use as
`font: var(--type-body);`.

| Token               | Value                          | Used for                                 |
|---------------------|--------------------------------|------------------------------------------|
| `--type-product-h1` | `600 24px/1.25 var(--font-ui)` | Portal page title (one per page).        |
| `--type-product-h2` | `600 18px/1.3 var(--font-ui)`  | Section / drawer titles.                 |
| `--type-body`       | `400 15px/1.55 var(--font-ui)` | Body copy.                               |
| `--type-body-sm`    | `400 14px/1.5 var(--font-ui)`  | Table cells, dense copy.                 |
| `--type-meta`       | `400 12px/1.4 var(--font-ui)`  | Timestamps, hints, KPI subtext.          |
| `--type-label`      | `600 11px/1.2 var(--font-ui)`  | Labels: uppercase, `.06em` tracking.     |

### Global form reset

`button, input, select, textarea { font: inherit; color: inherit; }` — form
controls otherwise fall back to the system font. `:root { accent-color: var(--accent); }`
makes native checkboxes, radios and ranges brass.

## Shared base

`apps/web/src/styles.scss` also carries the token layer, base resets,
`.form-error`, `.skip-link`, and `.sr-only`. Shared components live in
`src/app/shared/components/` (site-nav, site-footer, address-autocomplete,
property-card, wizard-steps); shared logic in `src/app/core/`. Build common
things once and reuse — never duplicate type/color styles per component.

## Checklist for future stories

1. Wordmark → `--font-wordmark`. Headline on a marketing page → `--font-headline`.
   Anything else → `--font-ui`.
2. Sizes via the `--type-*` tokens, not ad-hoc px.
3. Colors via the palette tokens, not hex literals.
4. If a new size or color is genuinely needed, add it to `styles.scss` and
   document it here — don't fork a local copy.
