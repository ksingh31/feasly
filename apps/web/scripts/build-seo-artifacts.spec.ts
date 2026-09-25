/**
 * SEO-02: sitemap.xml + robots.txt generation tests.
 *
 * Verifies the build-output contract: sitemap includes static routes +
 * all 40 community pages, excludes wizard/report/API patterns, robots.txt
 * has the exact disallow list and Sitemap line, and the XML is well-formed.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSeoArtifacts } from './build-seo-artifacts.js';

describe('build-seo-artifacts (SEO-02)', () => {
  it('generates sitemap.xml with static routes and all 40 community pages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seo-'));
    const { sitemapXml, urlCount } = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir });

    // Static routes present.
    for (const path of ['/', '/privacy', '/terms', '/how-it-works', '/faq', '/communities/', '/developers']) {
      expect(sitemapXml).toContain(`<loc>https://example.com${path}</loc>`);
    }

    // All 40 community pages present (spot-check + count).
    expect(sitemapXml).toContain('<loc>https://example.com/communities/beltline/</loc>');
    expect(sitemapXml).toContain('<loc>https://example.com/communities/panorama-hills/</loc>');
    const communityUrls = sitemapXml.match(/\/communities\/[a-z-]+\//g) ?? [];
    // 40 community pages (the /communities/ index is matched separately above).
    expect(communityUrls.length).toBe(40);

    // Total: 7 static + 40 community (+ sample-report if present in prerender routes).
    expect(urlCount).toBeGreaterThanOrEqual(47);

    expect(readFileSync(join(dir, 'sitemap.xml'), 'utf-8')).toBe(sitemapXml);
  });

  it('emits valid XML with lastmod/changefreq/priority', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seo-'));
    const { sitemapXml } = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir });

    expect(sitemapXml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(sitemapXml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemapXml).toContain('</urlset>');

    // Landing page has weekly/1.0 per SEO-02 AC2.
    expect(sitemapXml).toMatch(
      /<loc>https:\/\/example\.com\/<\/loc>\s*<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>\s*<changefreq>weekly<\/changefreq>\s*<priority>1\.0<\/priority>/,
    );
  });

  it('never includes excluded wizard/report/API patterns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seo-'));
    const { sitemapXml } = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir });

    for (const pattern of ['/r/', '/estimate/', '/preview', '/check-email', '/analyzing', '/embed/', '/admin/', '/api/']) {
      expect(sitemapXml).not.toContain(`<loc>https://example.com${pattern}`);
    }
    // No /r/{token} pattern URLs.
    expect(sitemapXml).not.toMatch(/\/r\/[a-zA-Z0-9_-]+/);
  });

  it('generates robots.txt with exact disallow list and Sitemap line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seo-'));
    const { robotsTxt } = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir });

    expect(robotsTxt).toContain('User-agent: *');
    expect(robotsTxt).toContain('Allow: /');

    const expectedDisallow = ['/r/', '/estimate/', '/preview', '/check-email', '/analyzing', '/embed/', '/admin/', '/api/'];
    for (const path of expectedDisallow) {
      expect(robotsTxt).toContain(`Disallow: ${path}`);
    }

    expect(robotsTxt).toContain('Sitemap: https://example.com/sitemap.xml');
    expect(readFileSync(join(dir, 'robots.txt'), 'utf-8')).toBe(robotsTxt);
  });

  it('is deterministic (same inputs → identical outputs)', () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'seo-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'seo-'));
    const a = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir1 });
    const b = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir2 });

    expect(a.sitemapXml).toBe(b.sitemapXml);
    expect(a.robotsTxt).toBe(b.robotsTxt);
  });
});
