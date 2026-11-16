/**
 * #832: every public (non-portal) route the WCAG 2.2 AA sweep visits.
 *
 * Plain data (no Playwright import), like builder-routes.ts / admin-routes.ts.
 * Portal routes are covered by builder-no-overflow / admin-no-overflow, which
 * run the same axe gate. Wizard steps that need state (scope, preview,
 * report) are reached by driving the flow in public-a11y.e2e.ts instead.
 *
 * `ready` is a selector that only exists once real content has rendered.
 */
export interface PublicA11yRoute {
  readonly url: string;
  /** File-safe name for screenshots. */
  readonly name: string;
  readonly ready: string;
}

export const PUBLIC_A11Y_ROUTES: readonly PublicA11yRoute[] = [
  { url: '/', name: 'landing', ready: 'h1' },
  { url: '/how-it-works', name: 'how-it-works', ready: 'h1' },
  { url: '/faq', name: 'faq', ready: 'h1' },
  { url: '/guides/cost-to-build-a-house-calgary', name: 'guide-cost', ready: 'h1' },
  { url: '/guides/calgary-zoning-explained', name: 'guide-zoning', ready: 'h1' },
  { url: '/developers', name: 'developers', ready: 'h1' },
  { url: '/communities/', name: 'communities', ready: 'h1' },
  { url: '/communities/beltline/', name: 'community-beltline', ready: 'h1' },
  { url: '/sample-report', name: 'sample-report', ready: 'h1' },
  { url: '/privacy', name: 'privacy', ready: 'h1' },
  { url: '/terms', name: 'terms', ready: 'h1' },
  { url: '/privacy/my-data', name: 'privacy-my-data', ready: 'h1' },
  { url: '/my-report', name: 'my-report', ready: 'h1' },
  { url: '/estimate/reno-coming-soon', name: 'reno-coming-soon', ready: 'h1' },
  { url: '/estimate/compare', name: 'compare', ready: 'h1' },
  // Mock API: any token is a valid preference-center link.
  { url: '/unsubscribe/e2e-token', name: 'unsubscribe', ready: 'h1' },
  // Mock API: an unknown token is the expired/invalid magic-link page.
  { url: '/r/e2e-unknown-token', name: 'magic-link-invalid', ready: 'h1' },
  // White-label embed (pilot): config answered by EMBED_CONFIG in the spec.
  { url: '/embed/e2e-tenant', name: 'embed', ready: '[role="combobox"]' },
  { url: '/embed', name: 'embed-missing-key', ready: 'h1' },
  { url: '/404', name: 'not-found', ready: 'h1' },
  { url: '/error', name: 'error', ready: 'h1' },
  { url: '/admin/login', name: 'admin-login', ready: 'h1' },
  { url: '/builder/login', name: 'builder-login', ready: 'h1' },
];
