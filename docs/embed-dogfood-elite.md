# EMB-05 — Elite Craft Builders dogfood (customer #1)

**Status:** Config complete and validated. Staging walk **pending** — blocked on
PR #81 (EMB-03) and PR #85 (admin/02) merging, plus browser QA.

## Tenant config

**File:** `config/builders/elite-craft-builders.json`
**Tenant key:** `elite-craft-builders`

| Field | Value | Notes |
|---|---|---|
| `business_name` | Elite Craft Builders | Real |
| `display_name` | Elite Craft Builders | Real |
| `accent_color` | `#B08D57` | Brass — matches Feasly brand. Contrast 3.09:1 vs white (below 4.5:1 AA; warning only per EMB-02 schema, builder's choice) |
| `allowed_origins` | `https://elitecraftbuilders.com` | Production domain. Staging origin to be added when Elite confirms it |
| `logo_url` | *(empty)* | **PLACEHOLDER** — Feasly wordmark fallback renders until Elite provides assets |
| `fallback_phone` | *(empty)* | **PLACEHOLDER** — fill when Elite provides |
| `fallback_email` | *(empty)* | **PLACEHOLDER** — fill when Elite provides |
| `plan` | `null` | Inert until billing lands (embed/04); null = undecided — Karan's call |

### Validation (AC1) ✅

```
npm run build:configs --workspace @feasly/api
# → validates against EMB-02 zod schema, exit 0
# → regenerates apps/api/src/generated/builder-configs.ts (in sync, no diff)
```

CI enforces this on every run (`.github/workflows/ci.yml` fails if the
generated file is stale; the generator itself throws on schema violations).

## Code-level verification (no browser)

- [x] **Embed route:** `/embed/:tenantKey` → `EmbedShellComponent`
  (`apps/web/src/app/app.routes.ts`). Visiting `/embed/elite-craft-builders`
  resolves the tenant.
- [x] **Config fetch:** `EmbedConfigService.getConfig('elite-craft-builders')`
  → `GET /api/v1/embed/config?key=elite-craft-builders` (public, unauthenticated
  by design; 404 `UNKNOWN_TENANT` on bad key).
- [x] **"Powered by Feasly" badge:** present in the embed shell template
  (`apps/web/src/app/features/embed/embed-shell.component.html:38`,
  `<span class="embed-badge">{{ copy.poweredBy }}</span>`,
  copy default `'Powered by Feasly'` in `app-config.defaults.ts:126`).
  Screenshot evidence still required (browser QA).
- [x] **Lead-gate tenant copy:** EMB-03 (PR #81) names the builder from the
  signed embed config in the gate consent copy — implemented, awaiting merge.
- [x] **Fail-closed:** embed config fetch failure surfaces an error card, never
  invented builder data (EMB-01).

## Staging walk checklist (browser QA — NOT YET RUN)

Run on staging once PR #81 and PR #85 are merged and deployed.
Browsers: Chrome + Safari/WebKit. Viewports: desktop + 375px mobile.

For each step, capture a screenshot and record the evidence in the table.

| # | Step | Expected | Evidence |
|---|---|---|---|
| 1 | Open `/embed/elite-craft-builders` on staging | Branded wizard shell loads; accent `#B08D57` applied; Feasly wordmark (logo placeholder) | Screenshot |
| 2 | "Powered by Feasly" badge | Visible badge in the embed chrome | Screenshot (AC3) |
| 3 | Complete address step (a Calgary address) | Autocomplete works; property card shows | Screenshot |
| 4 | Walk through scope/details to the lead gate | Gate copy reads "Your details go to **Elite Craft Builders**, who may contact you about this estimate." | Screenshot |
| 5 | Submit lead (use `karanbirsingh667@gmail.com` — the only approved test address) | Success state; no console errors | Lead ID: ___ |
| 6 | Admin: open `/admin/leads`, find the lead | Lead row shows `tenant_id = elite-craft-builders`, `source = 'embed'` | Screenshot |
| 7 | Magic-link email → open report | Report renders with Elite branding context | Screenshot |
| 8 | Console scan (all steps) | Zero errors, zero warnings attributable to the embed | Notes |
| 9 | 375px mobile | No overflow, badge readable, CTA reachable | Screenshot |
| 10 | Safari/WebKit | Same as Chrome, no rendering regressions | Screenshot |

### Walk result

*Not run yet — blocked (see below).*

## Blockers

1. **PR #81 (EMB-03, embed lead attribution) not merged.** The walk's steps 4–6
   (tenant-named gate copy, `tenant_id` attribution, `source='embed'`) depend on
   it. GitHub Actions is not triggering on the branch (known infra issue).
2. **PR #85 (admin/02, leads explorer) not merged.** Step 6 (verify attribution
   in the admin view) needs the admin leads UI/backend. Same CI issue.
3. **Browser QA.** This agent cannot operate a browser. The walk, screenshots,
   and 375px/Safari checks need a browser-task delegation once 1–2 are resolved.

## Issues found during config review

None — the config validates cleanly and the embed code paths it exercises
(route, config fetch, badge, fail-closed) are covered by existing tests.
Any issue found during the future staging walk becomes a tracked bug per the
standing bug rule (file before this story closes).

## Placeholders carried forward

- Elite logo URL, fallback phone/email — pending Elite brand assets.
- Staging origin in `allowed_origins` — pending Elite's staging domain.
- `plan: null` — Karan's commercial decision (see embed/04).
