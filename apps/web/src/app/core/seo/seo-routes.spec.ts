import { describe, expect, it } from 'vitest';
import { findSeoRoute, noindexPatterns, normalizeSeoPath } from './seo-routes';

/**
 * SEO-01: the route table resolves exact paths, `:param` segments, `**`
 * suffixes, normalizes, and always falls back (never throws). The noindex
 * list must keep pace with the story's coverage.
 */
describe('seo-routes', () => {
  it('matches exact indexable routes', () => {
    expect(findSeoRoute('privacy').titleKey).toBe('privacyTitle');
    expect(findSeoRoute('/terms/').titleKey).toBe('termsTitle');
    expect(findSeoRoute('').noindex).toBeFalsy();
    // Marketing pages (SEO-010): indexable, own title/description keys.
    expect(findSeoRoute('how-it-works').titleKey).toBe('howItWorksTitle');
    expect(findSeoRoute('how-it-works').noindex).toBeFalsy();
    expect(findSeoRoute('/faq/').titleKey).toBe('faqTitle');
    expect(findSeoRoute('faq').noindex).toBeFalsy();
    // API docs (api-mcp/03): indexable, own title/description keys.
    expect(findSeoRoute('developers').titleKey).toBe('developersTitle');
    expect(findSeoRoute('/developers/').noindex).toBeFalsy();
  });

  it('matches :param segments', () => {
    // Magic-link redemption (consumer/02) is now a real route with its own
    // title/description keys — still noindexed.
    expect(findSeoRoute('r/abc123').titleKey).toBe('magicLinkTitle');
    expect(findSeoRoute('r/abc123').noindex).toBe(true);
    // multi-token paths under a single-segment pattern do not match
    expect(findSeoRoute('r/abc/123').pattern).toBe('**');
  });

  it('matches ** suffix patterns at any depth', () => {
    expect(findSeoRoute('embed/acme').noindex).toBe(true);
    expect(findSeoRoute('embed/acme/embed.js').noindex).toBe(true);
    expect(findSeoRoute('admin').noindex).toBe(true);
    expect(findSeoRoute('admin/leads/1').noindex).toBe(true);
  });

  it('normalizes paths before matching', () => {
    expect(normalizeSeoPath('/estimate/scope/')).toBe('estimate/scope');
    expect(normalizeSeoPath('///PRIVACY')).toBe('PRIVACY');
    expect(findSeoRoute('/estimate/scope/').titleKey).toBe('scopeTitle');
  });

  it('falls back to the noindexed 404 entry for unknown routes', () => {
    const route = findSeoRoute('/some/missing/page');
    expect(route.pattern).toBe('**');
    expect(route.titleKey).toBe('notFoundTitle');
    expect(route.noindex).toBe(true);
  });

  it('resolves each admin section to its own title (admin/07)', () => {
    // Regression: /admin/billing inherited the disputes title and
    // /admin/builders fell through to the 404 title because sections
    // set (or never set) their own titles.
    const cases: Array<[string, string]> = [
      ['admin', 'adminHomeTitle'],
      ['admin/leads', 'adminLeadsTitle'],
      ['admin/builders', 'adminBuildersTitle'],
      ['admin/disputes', 'adminDisputesTitle'],
      ['admin/users', 'adminUsersTitle'],
      ['admin/calibration', 'adminCalibrationTitle'],
      ['admin/billing', 'adminBillingTitle'],
      ['admin/ops/sheets', 'adminSheetsTitle'],
      ['admin/estimates', 'adminEstimatesTitle'],
      ['admin/estimates/3f9b2c1a-0000-4000-8000-000000000000', 'adminEstimatesTitle'],
      ['admin/api-keys', 'adminApiKeysTitle'],
      ['admin/funnels', 'adminFunnelsTitle'],
      ['admin/login', 'adminLoginTitle'],
      ['admin/auth/callback', 'adminCallbackTitle'],
    ];
    for (const [path, titleKey] of cases) {
      const route = findSeoRoute(path);
      expect(route.titleKey, path).toBe(titleKey);
      expect(route.noindex, path).toBe(true);
    }
    // Unknown admin sub-paths fall back to the generic admin title —
    // never the 404 title.
    const fallback = findSeoRoute('admin/unknown-section');
    expect(fallback.pattern).toBe('admin/**');
    expect(fallback.titleKey).toBe('adminHomeTitle');
    expect(fallback.noindex).toBe(true);
  });

  it('every declared noindex pattern actually matches a concrete path', () => {
    const samples: Record<string, string> = {
      'estimate/scope': 'estimate/scope',
      'estimate/reno-scope': 'estimate/reno-scope',
      'estimate/details': 'estimate/details',
      'estimate/gate': 'estimate/gate',
      'estimate/analyzing': 'estimate/analyzing',
      'estimate/reno-coming-soon': 'estimate/reno-coming-soon',
      'estimate/preview': 'estimate/preview',
      'estimate/report': 'estimate/report',
      'estimate/compare': 'estimate/compare',
      '404': '404',
      error: 'error',
      preview: 'preview',
      'check-email': 'check-email',
      analyzing: 'analyzing',
      'r/:token': 'r/abc123',
      'unsubscribe/:token': 'unsubscribe/abc123',
      'embed/**': 'embed/acme/embed.js',
      'admin': 'admin',
      'admin/leads': 'admin/leads',
      'admin/builders': 'admin/builders',
      'admin/disputes': 'admin/disputes',
      'admin/users': 'admin/users',
      'admin/calibration': 'admin/calibration',
      'admin/billing': 'admin/billing',
      'admin/ops/sheets': 'admin/ops/sheets',
      'admin/estimates': 'admin/estimates',
      'admin/estimates/:id': 'admin/estimates/3f9b2c1a-0000-4000-8000-000000000000',
      'admin/api-keys': 'admin/api-keys',
      'admin/funnels': 'admin/funnels',
      'admin/login': 'admin/login',
      'admin/auth/callback': 'admin/auth/callback',
      'admin/**': 'admin/unknown-section',
      'builder/**': 'builder/login',
    };
    for (const pattern of noindexPatterns()) {
      const sample = samples[pattern];
      expect(sample, `no concrete sample for pattern ${pattern}`).toBeDefined();
      expect(findSeoRoute(sample).noindex).toBe(true);
    }
  });
});
