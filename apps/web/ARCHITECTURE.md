# Web app architecture

Designed to grow: consumer site today, builder dashboard and white-label embeds
tomorrow, without rewrites. Folders are the current boundary; any folder can be
lifted into a `packages/` library later with only import-path changes (the
`@app/*` aliases make that mechanical).

## Layout

```
src/app/
├── core/            # Singleton app-wide services. Provided in root, imported once.
│   ├── config/      # ConfigService — every tunable value lives here (FE0-002)
│   ├── api/         # ApiService interface + MockApiService + HttpApiService (FE0-003)
│   ├── seo/         # SeoService — titles, meta, OG, canonicals, JSON-LD (FE6-001)
│   └── analytics/   # First-party analytics, consent-aware (FE-1)
├── shared/          # Dumb, reusable pieces. NO business logic, NO app state.
│   ├── ui/          # Presentational components (buttons, cards, modals, inputs)
│   ├── pipes/       # Pure pipes (currency, date)
│   ├── directives/  # Attribute directives (autofocus, blur-up)
│   └── utils/       # Pure TS functions (formatting, validators) — no Angular deps
├── features/        # One folder per user flow. Lazy-loaded routes.
│   ├── landing/     # S0 + marketing pages (FE-1)
│   ├── wizard/      # S1–S3 + NGXS wizard store (FE-2)
│   ├── report/      # S4–S8 + NGXS report store (FE-3/4/5)
│   └── embed/       # Builder embed shell + tenant config (FE-7)
└── layout/          # App shell: header, footer, landmarks (FE0-004)
```

## Dependency rules (enforced by lint in FE0-006)

- `features/*` may import from `core`, `shared`, `@feasly/contracts` — **never**
  from another feature. Cross-feature communication goes through NGXS state or the router.
- `shared/*` may import only Angular, RxJS, and `@feasly/contracts` types.
  Nothing app-internal.
- `core/*` may import `@feasly/contracts` and `shared/utils` only.
- `layout` may import `shared` and `core`.

## State

NGXS stores live next to their feature (`features/wizard/wizard.state.ts`, etc.).
Cross-cutting UI state (none planned yet) would go in `core/`.

## Path aliases

`@app/core`, `@app/shared`, `@app/features`, `@app/layout` (see `tsconfig.json`).
Use them in every import — never relative `../../../` chains. When a folder is
promoted to a `packages/` library, only the alias target changes.

## Future expansion notes

- **Builder dashboard** → new `features/dashboard/` (or a second app reusing
  `packages/` libs).
- **Shared component library** → lift `shared/ui` → `packages/ui` when a second
  app needs it.
- **Pure utils** → lift `shared/utils` → `packages/utils` (zero Angular deps by rule,
  so this is trivial).
