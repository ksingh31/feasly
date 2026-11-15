/**
 * Parity: the indexable-pages manifest (sitemap, llms.txt and prerender-check
 * source) lists exactly the indexable, parameter-free routes in seo-routes.ts.
 * Adding a public route without a manifest entry — or the reverse — fails here.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSeoRoute, indexablePatterns } from '../src/app/core/seo/seo-routes.js';
import { DEFAULT_APP_CONFIG } from '../src/app/core/config/app-config.defaults.js';
import { canonicalPath, loadIndexablePages } from './indexable-pages.js';

describe('indexable-pages manifest', () => {
  const pages = loadIndexablePages();

  it('equals the non-noindex, param-free patterns in seo-routes.ts', () => {
    expect(pages.map((p) => p.pattern).sort()).toEqual(indexablePatterns().sort());
  });

  it('includes both long-form guides with guide JSON-LD checks', () => {
    const guides = pages.filter((p) => p.section === 'guides');
    expect(guides.map((p) => p.pattern).sort()).toEqual([
      'guides/calgary-zoning-explained',
      'guides/cost-to-build-a-house-calgary',
    ]);
    for (const g of guides) expect(g.jsonLd).toBe('guide');
  });

  it('every page has a meta description to use as its llms.txt summary', () => {
    const seo = DEFAULT_APP_CONFIG.copy.seo as Record<string, string>;
    for (const p of pages) {
      const route = findSeoRoute(p.pattern);
      expect(route.noindex).toBeFalsy();
      expect(seo[route.descriptionKey]?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it('builds trailing-slash canonical paths', () => {
    expect(canonicalPath('')).toBe('/');
    expect(canonicalPath('guides/calgary-zoning-explained')).toBe('/guides/calgary-zoning-explained/');
  });

  it('rejects param patterns and duplicates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'indexable-'));
    const entry = { pattern: 'faq', label: 'FAQ', section: 'pages', changefreq: 'monthly', priority: '0.8', jsonLd: null };
    const write = (pages: unknown[]) => {
      const file = join(dir, `${Math.random()}.json`);
      writeFileSync(file, JSON.stringify({ pages }));
      return file;
    };
    expect(() => loadIndexablePages(write([entry, entry]))).toThrow(/duplicate/);
    expect(() => loadIndexablePages(write([{ ...entry, pattern: 'r/:token' }]))).toThrow(/invalid pattern/);
    expect(() => loadIndexablePages(write([]))).toThrow(/no pages/);
  });
});
