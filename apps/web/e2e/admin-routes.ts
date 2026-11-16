/**
 * #548: every admin console route the no-overflow e2e visits, plus every
 * drawer / modal it opens and walks with the keyboard.
 *
 * Plain data (no Playwright import) so the vitest guard in
 * `tools/admin-e2e-routes.spec.ts` can check it against `app.routes.ts`
 * in CI: a new admin route without an entry here fails that spec.
 *
 * `path` is the router path as written in app.routes.ts (children of
 * `admin` are prefixed with `admin/`). `url` is what the browser opens.
 * `ready` is a selector that only exists once the page has rendered its
 * real content (not the skeleton), so the overflow check measures the
 * settled layout.
 */
export interface AdminE2eRoute {
  readonly path: string;
  readonly url: string;
  /** File-safe name for screenshots. */
  readonly name: string;
  readonly ready: string;
  /** True for pages that render before sign-in (no session fixture needed). */
  readonly public?: boolean;
}

const SHELL_READY = '#admin-main h1';

export const ADMIN_E2E_ROUTES: readonly AdminE2eRoute[] = [
  { path: 'admin/login', url: '/admin/login', name: 'login', ready: 'h1', public: true },
  {
    path: 'admin/auth/callback',
    url: '/admin/auth/callback?error=access_denied',
    name: 'auth-callback',
    ready: '[role="alert"]',
    public: true,
  },
  { path: 'admin/leads', url: '/admin/leads', name: 'leads', ready: SHELL_READY },
  { path: 'admin/quarantine', url: '/admin/quarantine', name: 'quarantine', ready: SHELL_READY },
  { path: 'admin/builders', url: '/admin/builders', name: 'builders', ready: SHELL_READY },
  { path: 'admin/users', url: '/admin/users', name: 'users', ready: SHELL_READY },
  { path: 'admin/disputes', url: '/admin/disputes', name: 'disputes', ready: SHELL_READY },
  { path: 'admin/calibration', url: '/admin/calibration', name: 'calibration', ready: SHELL_READY },
  { path: 'admin/billing', url: '/admin/billing', name: 'billing', ready: SHELL_READY },
  { path: 'admin/webhooks', url: '/admin/webhooks', name: 'webhooks', ready: SHELL_READY },
  { path: 'admin/ops/sheets', url: '/admin/ops/sheets', name: 'ops-sheets', ready: SHELL_READY },
  { path: 'admin/estimates', url: '/admin/estimates', name: 'estimates', ready: SHELL_READY },
  { path: 'admin/estimates/:id', url: '/admin/estimates/est-1', name: 'estimate-detail', ready: SHELL_READY },
  { path: 'admin/billing/invoices', url: '/admin/billing/invoices', name: 'invoices', ready: SHELL_READY },
  { path: 'admin/error', url: '/admin/error', name: 'error', ready: SHELL_READY },
  { path: 'admin/funnels', url: '/admin/funnels', name: 'funnels', ready: SHELL_READY },
  { path: 'admin/api-keys', url: '/admin/api-keys', name: 'api-keys', ready: SHELL_READY },
];

/**
 * Router paths that are deliberately not visited: pure `redirectTo`
 * entries (their targets are covered above).
 */
export const ADMIN_REDIRECT_PATHS: readonly string[] = ['admin', 'admin/billing/invoices/:id'];

/**
 * Overlays opened by the e2e. Drawers are URL-addressable (`?open=<id>`);
 * modals are opened by clicking `trigger` (a button's accessible name) on
 * the page at `url`. Every overlay is checked for overflow + axe, then
 * walked with the keyboard: focus lands inside the dialog, Tab stays
 * trapped inside it, and Escape closes it and returns focus to the page.
 */
export interface AdminE2eOverlay {
  readonly name: string;
  readonly url: string;
  /** Accessible name of the button that opens a modal (omit for `?open=` drawers). */
  readonly trigger?: string;
}

export const ADMIN_E2E_OVERLAYS: readonly AdminE2eOverlay[] = [
  { name: 'lead-drawer', url: '/admin/leads?open=lead-1' },
  { name: 'builder-drawer', url: '/admin/builders?open=b-2' },
  { name: 'user-drawer', url: '/admin/users?open=u-2' },
  { name: 'invoice-drawer', url: '/admin/billing/invoices?open=00000000-0000-4000-8000-000000000001' },
  { name: 'dispute-drawer', url: '/admin/disputes?open=dispute-1' },
  // #872: a Stripe chargeback — chip, evidence deadline, View in Stripe.
  { name: 'chargeback-drawer', url: '/admin/disputes?open=chargeback-1' },
  { name: 'api-key-drawer', url: '/admin/api-keys?open=key-1' },
  { name: 'add-builder-modal', url: '/admin/builders', trigger: 'Add builder' },
  { name: 'invite-user-modal', url: '/admin/users', trigger: 'Invite user' },
  { name: 'create-invoice-modal', url: '/admin/billing', trigger: 'Create invoice' },
  { name: 'issue-key-modal', url: '/admin/api-keys', trigger: 'Issue key' },
];
