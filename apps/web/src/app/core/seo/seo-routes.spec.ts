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
    expect(findSeoRoute('r/abc123').titleKey).toBe('notFoundTitle');
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

  it('every declared noindex pattern actually matches a concrete path', () => {
    const samples: Record<string, string> = {
      'estimate/scope': 'estimate/scope',
      'estimate/reno-scope': 'estimate/reno-scope',
      'estimate/details': 'estimate/details',
      'estimate/gate': 'estimate/gate',
      'estimate/analyzing': 'estimate/analyzing',
      'estimate/preview': 'estimate/preview',
      'estimate/report': 'estimate/report',
      'estimate/compare': 'estimate/compare',
      '404': '404',
      error: 'error',
      preview: 'preview',
      'check-email': 'check-email',
      analyzing: 'analyzing',
      'r/:token': 'r/abc123',
      'embed/**': 'embed/acme/embed.js',
      'admin/**': 'admin/leads',
      'builder/**': 'builder/login',
    };
    for (const pattern of noindexPatterns()) {
      const sample = samples[pattern];
      expect(sample, `no concrete sample for pattern ${pattern}`).toBeDefined();
      expect(findSeoRoute(sample).noindex).toBe(true);
    }
  });
});
