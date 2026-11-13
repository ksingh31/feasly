# Portal UI kit: one design for the builder portal and the admin console

**Status:** approved direction (2026-11-13), the spec for Phase 1 stories.
**Sources:** [admin review](../reviews/2026-11-13-admin.md), [builder review](../reviews/2026-11-13-builder.md), [design tokens](../design-tokens.md).
**Rule:** builder and admin pages are built **only** from this kit plus tokens. No feature-level hex colours, button styles, modals or tables.

The builder portal is customer-facing and the admin console is internal, but both run on the same kit, tokens and interaction model. They differ in shell and density, not components.

---

## 1. Tokens (add to `apps/web/src/styles.scss`, document in `design-tokens.md`)

Existing brand tokens (`--cream`, `--card`, `--canvas`, `--text`, `--accent`, `--border`, `--danger`, `--focus-ring`, fonts) stay. Add:

```scss
/* Text on cream: --accent is 3.6:1 on cream, so text uses a darker brass */
--accent-text: #8a5f12;          /* ≥ 4.5:1 on --cream and --card */
--muted: #6b5f53;                /* was #7a6e62 (4.2:1 on --cream-2) */

/* Semantic status tones (chips, banners, KPI borders) */
--status-neutral-bg: #efebe4;  --status-neutral-fg: #4a4239;
--status-info-bg:    #e6eef9;  --status-info-fg:    #1f4f8f;
--status-progress-bg:#f3ead8;  --status-progress-fg:#7a5410;
--status-success-bg: #e3f2ea;  --status-success-fg: #1c6b44;
--status-warning-bg: #fbefd9;  --status-warning-fg: #8a4b06;
--status-danger-bg:  #fbe7e5;  --status-danger-fg:  #9b2018;
--status-paused-bg:  #ede8f5;  --status-paused-fg:  #5a3f8c;

/* Spacing scale (4px base) */
--space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
--space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;

/* Radius, elevation, layers */
--radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px; --radius-pill: 999px;
--shadow-overlay: 0 12px 40px rgba(28, 25, 20, .18);
--scrim: rgba(28, 25, 20, .32);
--z-sticky: 10; --z-drawer: 40; --z-modal: 50; --z-toast: 60;

/* Product type scale (portals): all --font-ui, never --font-headline */
--type-product-h1: 600 24px/1.25 var(--font-ui);
--type-product-h2: 600 18px/1.3 var(--font-ui);
--type-body:       400 15px/1.55 var(--font-ui);
--type-body-sm:    400 14px/1.5 var(--font-ui);
--type-meta:       400 12px/1.4 var(--font-ui);
--type-label:      600 11px/1.2 var(--font-ui); /* uppercase, .06em tracking */
```

Global reset (fixes system-font buttons): `button, input, select, textarea { font: inherit; color: inherit; }` and `:root { accent-color: var(--accent); }`.

**Lint:** add a stylelint rule (or extend `check-no-hardcode.mjs`) that fails on hex/rgb literals in `features/**/*.scss`. Only `styles.scss` defines colours.

## 2. Status dictionary (`shared/ui/status/status-dictionary.ts`)

One map from domain status to `{ label, tone }`, used by every chip, banner, table and email:

| Domain | Status → tone |
|---|---|
| Lead | new→info · contacted→progress · quoting→warning · won→success · lost→neutral |
| Invoice | draft→neutral · in_review→warning ("Auto-charges in N days") · finalized→info · paid→success · failed→danger · disputed→paused · void→neutral |
| Member/user | active→success · invited→info · deactivated→neutral |
| Builder | active→success · past_due→warning · degraded→danger · suspended→danger |
| API key | active→success · revoked→neutral |
| Dispute SLA | >1 day left→neutral · due today→warning · overdue→danger |

Labels are sentence case ("In review", "E-transfer"). Enum values never reach the UI raw (`new_build` → "New build").

## 3. Components (`apps/web/src/app/shared/ui/`)

Standalone, OnPush, signal inputs, tokens only, Angular CDK for overlays and focus. Every component ships with a spec, a 390px check and axe zero critical/serious.

| Component | Spec |
|---|---|
| **Button** (`ui-button`) | Variants `primary` (charcoal `--canvas` / `--on-dark`), `secondary` (card + `--border`), `ghost`, `danger`, `danger-secondary`. Sizes `sm` 32px, `md` 40px; on mobile the tap area is at least 44px. Loading state keeps the button's width. Disabled is 40% opacity with `not-allowed`, so an enabled button must never look disabled. Focus ring `0 0 0 3px var(--focus-ring)`. One primary per view. |
| **StatusChip** | 22px pill, `--type-label` without uppercase, tone from the status dictionary, optional leading dot. |
| **PageLayout** | Content max-width 1120px (builder) / fluid ≤1440px (admin); `narrow` variant 640px for forms; gutter 32px desktop, 16px mobile. No nested tinted "card in a card". |
| **PageHeader** | Optional breadcrumbs, one H1 (`--type-product-h1`), a single-line description, actions on the right (1 primary + ≤2 secondary + overflow). Actions wrap under the title on mobile. |
| **DataTable** | Column config; sortable headers (`aria-sort`); 48px rows (36px compact); right-aligned tabular money; `nowrap` IDs; 2-line clamp plus tooltip. Clicking a row (or Enter) opens the drawer; the selected row gets the `--accent-bg` highlight. Optional selection plus bulk bar. Row actions: one inline button plus a kebab. Slots: loading skeleton (5 rows), empty, error. Pagination only when there's more than one page. **Below 768px it renders as a card list** (title, chip, 2–3 meta lines, chevron). It must never widen the page. |
| **FilterBar** | Search (250ms debounce, `/` focuses it), ≤3 inline selects, "More filters", active-filter chips with × and "Clear all" (only when a filter is active). Synced to query params. On mobile: [Search] [Filters (n)] opening a bottom sheet. |
| **Drawer** | Right side; widths `sm` 400, `md` 480/560, `lg` 640/720; **full-height sheet below 768px**. Sticky header (title, chip + meta, close ×) and sticky footer (secondary left, primary right). Body scrolls; page scroll locked; scrim `--scrim`. Esc closes, asking first if there are unsaved changes. Focus goes to the title on open and back to the trigger on close. URL-synced (`?open=<id>`). One drawer at a time; a modal may stack on top. |
| **Modal** | Centred `sm` 400 / `md` 560 / `lg` 720, max-height 85vh. Header (title + ×), body, sticky footer. **Bottom sheet below 768px** (drag handle, safe-area padding). Focus goes to the first field; Enter submits when valid; the scrim click is disabled for one-time-secret modals. |
| **ConfirmDialog** | `confirm({ title, body, verb, tone: 'danger'|'default', typeToConfirm? })` → Observable<boolean>. The title names the object ("Deactivate Marco Silva?"), the body states the consequence (amount and builder for money actions). For danger, Cancel has default focus and the verb button uses the danger variant. Required for deactivate, delete, revoke, rotate, retry charge, mark paid, accept/reject dispute, discard quarantine, and recording a contract. |
| **Toast** | Bottom-right (bottom-centre on mobile), auto-dismiss 5s, optional Undo. Replaces inline success banners and the select + Apply pattern for instant changes. |
| **EmptyState / ErrorState / Skeleton** | Icon, title, one line, optional action. Variants: `zero-data`, `no-results` (only when filters are active), `all-clear`, `error` (with Retry), `not-found` ("Back to {list}", never "Try again" on a 404). |
| **KpiTile / MoneyStrip** | KPI: label (`--type-label`), value 24px/600 tabular, sub (`--type-meta`), optional tone border, optional click-through. Grid `repeat(auto-fit, minmax(200px, 1fr))`. MoneyStrip: one severity-tiered line ("1 card failed · $19,800 charges tonight"), with one CTA. |
| **KeyValueList** | Two-column label/value grid that collapses to stacked on narrow screens. Replaces label/value rows pushed to opposite edges. |
| **Timeline** | Vertical events (icon, humanised title, actor, relative time, expandable raw payload). Always sorted by timestamp. |
| **EntityLink / EntityCombobox** | Human label (invoice number, lead name, builder) that opens the record's drawer, with copy-ID on hover. A type-ahead combobox replaces every "paste a UUID" field. |
| **Fields** | `TextField`, `Select` (one chevron), `MoneyField` (`inputmode=numeric`, live thousands separators), `DateField`. Label above, hint below, error in `--status-danger-fg`. |
| **Stepper** | Lead status (New → Contacted → Quoted → Won/Lost) and invoice lifecycle (Issued → Review window → Charged → Paid). |

Formatting pipes (`shared/ui/format/`): `date` (Nov 12, 2026), `dateTime` (Nov 12, 2026 · 11:30 a.m. MT), `relative` ("2 days ago", absolute value on hover), `money` (whole dollars, tabular), `count` (1,843). All are built on the existing `datetime.ts`, `edmonton.ts` and `money.ts`. No seconds, no raw ISO.

## 4. Shells

Both shells use the same components; they differ in navigation.

- **Admin shell:** left sidebar (240px, collapsible to a 64px rail; off-canvas below 1024px) grouped into **Pipeline** (Leads, Quarantine, Estimates) · **Partners** (Builders, Users & access, API keys) · **Money** (Billing overview, Invoices, Disputes) · **System** (Calibration, Sheets sync, Funnels, Webhooks). Queue badges, a 56px top bar (breadcrumbs, ⌘K search, env chip, user menu), and an admin error boundary that keeps errors inside the shell.
- **Builder shell:** slim top bar with **Leads · Money · Team** (Money and Team are admin role only) and an account menu (current org name, org switcher, email, sign out). **Bottom tab bar below 768px.** "Record contract" is an action from a won lead or Money, not a nav item. A failed-card danger strip persists across pages until it's resolved.

## 5. Interaction rules

- Changes that don't involve money apply immediately with an undo toast (lead status, member role). Money changes go through a Modal that shows before and after (rate, payment method, record payment, record contract).
- Every destructive or money action goes through a ConfirmDialog.
- Every record reference is an EntityLink; no raw UUIDs outside a collapsed "Technical IDs" section.
- Keyboard: `/` search, ⌘K command palette (admin), J/K between rows and records, Enter opens, Esc closes the top overlay.
- Phone and email are always `tel:` / `mailto:` links.
- No page may exceed the viewport at 390px (`scrollWidth <= innerWidth`). Assert this in e2e for every portal route.

## 6. Definition of done for kit components and migrated pages

Unit specs; screenshots at 1440 and 390 in the PR; axe zero critical/serious; keyboard path tested (open, operate, close, focus return); the feature SCSS for a migrated page contains no hex literals; `bash tools/verify-local.sh` → `VERIFY: PASS`.
