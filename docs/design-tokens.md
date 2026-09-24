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
| `--muted`      | `#7a6e62`            | Secondary text.                             |
| `--on-dark`    | `#ede9e2`            | Text on dark surfaces.                      |
| `--on-dark-muted` | `#8c8278`         | Secondary text on dark.                     |
| `--accent`     | `#a8761a`            | Brass — eyebrows, links, step numbers, focus.|
| `--accent-dark`| `#c49235`            | Brass on dark surfaces.                     |
| `--accent-bg`  | `rgba(168,118,26,.08)` | Brass wash behind badges.                  |
| `--border`     | `rgba(26,22,18,.1)`  | Hairline borders on cream.                  |
| `--danger`     | `#b3261e`            | Errors.                                     |
| `--focus-ring` | `rgba(168,118,26,.35)` | Focus outlines.                           |

Karan prefers this warm cream/charcoal/brass direction over the older live
site look — when in doubt, lean warmer and roomier, not flatter and greyer.

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
