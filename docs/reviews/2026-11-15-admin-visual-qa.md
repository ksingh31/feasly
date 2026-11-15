# Admin console: visual QA re-run (2026-11-15)

Story 26 of [2026-11-13-admin.md](2026-11-13-admin.md), issue #548. This re-runs the
2026-11-13 screenshot audit on the redesigned console (#539, #541–#547) and turns it
into a gate you can repeat.

## Method

- **Suite:** `apps/web/e2e/admin-no-overflow.e2e.ts`. It runs against the production
  build served by `tools/serve-dist.mjs`. Contract-shaped fixtures in
  `e2e/admin-api-fixtures.ts` answer every admin API call, so no Functions host,
  database or Entra tenant is needed. The fixtures use long names, emails, addresses
  and key names, so the layout is tested under realistic pressure.
- **Viewports:** 1440×900 and 390×844.
- **Per route** (all 16 non-redirect admin routes, listed in `e2e/admin-routes.ts`),
  the suite checks four things:
  - the page settles: ready selector visible, no skeletons;
  - `scrollWidth <= innerWidth`, i.e. no horizontal overflow;
  - axe (WCAG 2.0/2.1 A + AA) reports zero critical or serious violations;
  - no API call goes unanswered.
- **Per drawer or modal** (10 overlays), the suite runs the same checks with the
  overlay open, then walks the keyboard path:
  - focus is inside the dialog when it opens;
  - 40 × Tab and 40 × Shift+Tab never leave the dialog;
  - Escape closes it.
- **Coverage guard:** `tools/admin-e2e-routes.spec.ts` runs in CI with
  `test:tools`. It fails when an admin route in `app.routes.ts` has no e2e entry,
  when an entry is stale, or when a page with a drawer has no overlay check.

Rerun it:

```bash
npm run build --workspace=@feasly/web -- --configuration=production
E2E_SCREENSHOTS=1 npm run e2e --workspace=@feasly/web   # PLAYWRIGHT_CHANNEL=chrome if no bundled Chromium
# screenshots: apps/web/e2e-results/screenshots/admin-<name>-<1440|390>.png (gitignored)
```

## Result

**52 / 52 checks pass** after the fixes below (26 targets × 2 viewports). The builder
suite (#536) still passes, 18 / 18.

### Routes (1440 and 390)

| Route | Overflow | axe crit/serious | Unhandled API |
|---|---|---|---|
| `/admin/login` | none | 0 | 0 |
| `/admin/auth/callback?error=…` | none | 0 | 0 |
| `/admin/leads` | none | 0 | 0 |
| `/admin/builders` | **fixed** (390) | 0 | 0 |
| `/admin/users` | none | 0 | 0 |
| `/admin/disputes` | none | 0 | 0 |
| `/admin/calibration` | none | 0 | 0 |
| `/admin/billing` | none | 0 | 0 |
| `/admin/webhooks` | none | 0 | 0 |
| `/admin/ops/sheets` | none | 0 | 0 |
| `/admin/estimates` | none | 0 | 0 |
| `/admin/estimates/:id` | none | 0 | 0 |
| `/admin/billing/invoices` | none | 0 | 0 |
| `/admin/error` | none | **fixed** (contrast) | 0 |
| `/admin/funnels` | none | 0 | 0 |
| `/admin/api-keys` | none | 0 | 0 |

The redirect-only routes `/admin` and `/admin/billing/invoices/:id` are covered by
their targets.

### Drawers and modals (1440 and 390)

| Overlay | Overflow | axe | Focus in | Tab trap | Esc closes |
|---|---|---|---|---|---|
| Lead drawer | none | 0 | ✓ | ✓ | ✓ |
| Builder drawer | **fixed** (390) | 0 | ✓ | ✓ | ✓ |
| User drawer | none | 0 | ✓ | ✓ | ✓ |
| Invoice drawer | none | 0 | ✓ | ✓ | ✓ |
| Dispute drawer | none | 0 | ✓ | ✓ | ✓ |
| API key drawer | none | 0 | ✓ | ✓ | ✓ |
| Add builder | none | 0 | ✓ | ✓ | ✓ |
| Invite user | none | 0 | **fixed** | **fixed** | **fixed** |
| Create invoice | none | 0 | ✓ | ✓ | ✓ |
| Issue key | none | 0 | ✓ | ✓ | ✓ |

## Bugs found and fixed in this PR

| # | Where | Finding | Fix |
|---|---|---|---|
| Q1 | Users → Invite user | The modal was the last hand-built overlay. Focus stayed on the page when it opened, Tab escaped to the page behind, and Escape did nothing. | Moved it to the kit (`UiModalService` + `ui-modal`, new `AdminUserInviteModalComponent`): CDK focus trap, Esc/scrim, focus return, bottom sheet on phones, kit fields. It stays driven by `AdminUsersState.inviteOpen`. |
| Q2 | Builders at 390 (table and with drawer open) | A long business name or tenant key ("Northern Lights Custom Homes & Renovations Ltd.") pushed the page to 435px. The `inline-flex` builder cell didn't shrink inside the phone card. | `display: flex; max-width: 100%` on the cell. The tenant key now ellipsizes. |
| Q3 | `/admin/error` | axe `color-contrast` (serious): "Try again" was white on `--accent` brass. | It now uses the kit `ui-button` primary. |
| Q4 | Users header | "Invite user" was a page-local brass button (review M6). | It now uses `ui-button` primary, matching Add builder and Issue key. |

## Observations (no change in this PR)

- **Full-page captures at 1440:** the sticky 100vh sidebar's background ends at the
  first screen height in full-page screenshots. This is a capture artifact; the live
  page is fine. Captures now run with `animations: 'disabled'`, because one capture
  had caught the sidebar's width transition mid-flight.
- **Leads at 390:** the saved-view strip ("All · New · Unassigned · Quoting > 7 days")
  is a horizontal scroller, and its last tab is cut at the edge. This is intended and
  doesn't overflow the page, but a fade or scroll affordance would make it obvious.
- **Invoice drawer meta at 390:** the tenant key and the lead link wrap onto separate
  lines, which leaves a trailing "·" separator. Cosmetic.
- **Users page shell:** the Users page still uses its own header and padding instead
  of `ui-page-header`/`ui-page-layout` like Builders and API keys (review S1). Its
  content starts at a different x and width from the neighbouring pages.
- **Builders at 390:** the status chip drops under a long business name instead of
  staying top-right. Readable, but not the card spec's "chip on the right".
