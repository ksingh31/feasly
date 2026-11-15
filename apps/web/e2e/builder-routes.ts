/**
 * #536: every builder portal route the no-overflow e2e visits.
 *
 * Plain data (no Playwright import) so the vitest guard in
 * `tools/builder-e2e-routes.spec.ts` can check it against `app.routes.ts`
 * in CI: a new builder route without an entry here fails that spec.
 *
 * `path` is the router path as written in app.routes.ts (children of
 * `builder` are prefixed with `builder/`; the shell's index route is
 * `builder`). `url` is what the browser opens. `ready` is a selector that
 * only exists once the page has rendered its real content (not the
 * skeleton), so the overflow check measures the settled layout.
 */
export interface BuilderE2eRoute {
  readonly path: string;
  readonly url: string;
  /** File-safe name for screenshots. */
  readonly name: string;
  readonly ready: string;
  /** True for pages that render before sign-in (no session fixture needed). */
  readonly public?: boolean;
}

export const BUILDER_E2E_ROUTES: readonly BuilderE2eRoute[] = [
  { path: 'builder/login', url: '/builder/login', name: 'login', ready: 'h1', public: true },
  {
    path: 'builder/auth/callback',
    url: '/builder/auth/callback?error=access_denied',
    name: 'auth-callback',
    ready: '[role="alert"]',
    public: true,
  },
  { path: 'builder/org-picker', url: '/builder/org-picker', name: 'org-picker', ready: 'h1' },
  { path: 'builder', url: '/builder', name: 'leads', ready: '.builder-shell h1' },
  { path: 'builder/money', url: '/builder/money', name: 'money', ready: '.builder-shell h1' },
  { path: 'builder/billing', url: '/builder/billing', name: 'billing', ready: '.builder-shell h1' },
  { path: 'builder/invoices', url: '/builder/invoices', name: 'invoices', ready: '.builder-shell h1' },
  { path: 'builder/team', url: '/builder/team', name: 'team', ready: '.builder-shell h1' },
  {
    path: 'builder/record-contract',
    url: '/builder/record-contract',
    name: 'record-contract',
    ready: '.builder-shell h1',
  },
];

/**
 * Router paths that are deliberately not visited: pure `redirectTo`
 * entries (their targets are covered above).
 */
export const BUILDER_REDIRECT_PATHS: readonly string[] = [
  'builder/billing/invoices',
  'builder/report-contract',
];
