/**
 * SEO-02: sitemap.xml + robots.txt generation tests.
 *
 * Verifies the build-output contract: sitemap includes static routes +
 * all 40 community pages, excludes wizard/report/API patterns, robots.txt
 * has the exact disallow list and Sitemap line, and the XML is well-formed.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyNoindexToSwaConfig,
  buildSeoArtifacts,
  loadConfig,
  serializeSwaConfig,
  SWA_CONFIG_MAX_BYTES,
} from './build-seo-artifacts.js';

describe('build-seo-artifacts (SEO-02)', () => {
  it('generates sitemap.xml with static routes and all 40 community pages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seo-'));
    const { sitemapXml, urlCount } = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir, indexable: true });

    // Static routes present.
    // Trailing-slash form, matching the canonicals (#707).
    for (const path of ['/', '/privacy/', '/terms/', '/how-it-works/', '/faq/', '/guides/cost-to-build-a-house-calgary/', '/guides/calgary-zoning-explained/', '/communities/', '/developers/']) {
      expect(sitemapXml).toContain(`<loc>https://example.com${path}</loc>`);
    }

    // Every community page present (spot-check + count from the aggregates).
    const total = (
      JSON.parse(
        readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'content', 'data', 'community-aggregates.json'), 'utf-8'),
      ) as { communities: unknown[] }
    ).communities.length;
    expect(total).toBeGreaterThanOrEqual(40);
    expect(sitemapXml).toContain('<loc>https://example.com/communities/beltline/</loc>');
    expect(sitemapXml).toContain('<loc>https://example.com/communities/panorama-hills/</loc>');
    const communityUrls = sitemapXml.match(/\/communities\/[a-z0-9-]+\//g) ?? [];
    // One per community page (the /communities/ index is matched separately above).
    expect(communityUrls.length).toBe(total);

    // Total: 9 static + the community pages. /sample-report is deliberately
    // excluded (noindex route — must never appear in the sitemap).
    expect(urlCount).toBe(9 + total);

    expect(readFileSync(join(dir, 'sitemap.xml'), 'utf-8')).toBe(sitemapXml);
  });

  it('emits valid XML with lastmod/changefreq/priority', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seo-'));
    const { sitemapXml } = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir, indexable: true });

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
    const { sitemapXml } = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir, indexable: true });

    for (const pattern of ['/r/', '/estimate/', '/preview', '/check-email', '/analyzing', '/embed/', '/admin/', '/api/']) {
      expect(sitemapXml).not.toContain(`<loc>https://example.com${pattern}`);
    }
    // No /r/{token} pattern URLs.
    expect(sitemapXml).not.toMatch(/\/r\/[a-zA-Z0-9_-]+/);
  });

  it('never includes the noindex /sample-report page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seo-'));
    const { sitemapXml } = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir, indexable: true });

    // /sample-report is a noindex trust page (not a search landing page):
    // emitting it in the sitemap would send conflicting signals to crawlers.
    expect(sitemapXml).not.toContain('sample-report');
  });

  it('generates robots.txt with exact disallow list and Sitemap line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seo-'));
    const { robotsTxt } = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir, indexable: true });

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
    const a = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir1, indexable: true });
    const b = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir2, indexable: true });

    expect(a.sitemapXml).toBe(b.sitemapXml);
    expect(a.robotsTxt).toBe(b.robotsTxt);
  });

  it('every <loc> ends with a slash (canonical URL form, #707)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seo-'));
    const { sitemapXml } = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir, indexable: true });
    const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) expect(loc).toMatch(/\/$/);
  });
});

describe('build-seo-artifacts non-production noindex (#707)', () => {
  const swaFixture = {
    globalHeaders: { 'X-Content-Type-Options': 'nosniff' },
    routes: [{ route: '/r/*', rewrite: '/index.html' }],
    responseOverrides: { '404': { rewrite: '/404.html', statusCode: 404 } },
  };

  function withSwaConfig(): string {
    const dir = mkdtempSync(join(tmpdir(), 'seo-'));
    writeFileSync(join(dir, 'staticwebapp.config.json'), JSON.stringify(swaFixture));
    return dir;
  }

  it('without SITE_URL: X-Robots-Tag on every response and robots.txt served as Disallow: /', () => {
    const dir = withSwaConfig();
    const result = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir, indexable: false });
    expect(result.noindexApplied).toBe(true);

    const swa = JSON.parse(readFileSync(join(dir, 'staticwebapp.config.json'), 'utf-8'));
    expect(swa.globalHeaders['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(swa.globalHeaders['X-Content-Type-Options']).toBe('nosniff');
    expect(swa.routes[0]).toEqual({ route: '/robots.txt', rewrite: '/robots.noindex.txt' });
    expect(swa.routes).toContainEqual({ route: '/r/*', rewrite: '/index.html' });
    expect(swa.responseOverrides).toEqual(swaFixture.responseOverrides);

    const noindexRobots = readFileSync(join(dir, 'robots.noindex.txt'), 'utf-8');
    expect(noindexRobots).toMatch(/^User-agent: \*$/m);
    expect(noindexRobots).toMatch(/^Disallow: \/$/m);
    expect(noindexRobots).not.toMatch(/^Allow:/m);
    // The on-disk robots.txt keeps the production form (local Lighthouse server).
    expect(readFileSync(join(dir, 'robots.txt'), 'utf-8')).toBe(result.robotsTxt);
  });

  it('the checked-in SWA config fits the Static Web Apps size limit once minified (#690)', () => {
    const swa = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'staticwebapp.config.json'), 'utf-8'));
    // Both the production form and the non-production (noindex) form.
    expect(Buffer.byteLength(serializeSwaConfig(swa))).toBeLessThanOrEqual(SWA_CONFIG_MAX_BYTES);
    expect(Buffer.byteLength(serializeSwaConfig(applyNoindexToSwaConfig(swa)))).toBeLessThanOrEqual(SWA_CONFIG_MAX_BYTES);
  });

  it('fails the build when the SWA config is over the size limit', () => {
    const huge = { routes: Array.from({ length: 400 }, (_, i) => ({ route: `/communities/c-${i}`, redirect: `/communities/c-${i}/` })) };
    expect(() => serializeSwaConfig(huge)).toThrow(/Static Web Apps limit/);
  });

  it('with SITE_URL: SWA config content untouched (minified), no noindex robots file', () => {
    const dir = withSwaConfig();
    const result = buildSeoArtifacts({ siteUrl: 'https://example.com', outputDir: dir, indexable: true });
    expect(result.noindexApplied).toBe(false);
    const written = readFileSync(join(dir, 'staticwebapp.config.json'), 'utf-8');
    expect(JSON.parse(written)).toEqual(swaFixture);
    expect(written).toBe(`${JSON.stringify(swaFixture)}\n`);
    expect(existsSync(join(dir, 'robots.noindex.txt'))).toBe(false);
  });

  it('applyNoindexToSwaConfig is idempotent', () => {
    const once = applyNoindexToSwaConfig(swaFixture);
    expect(applyNoindexToSwaConfig(once)).toEqual(once);
    expect(once.routes?.filter((r) => r.route === '/robots.txt')).toHaveLength(1);
  });

  it('loadConfig: indexable only when SITE_URL is set', () => {
    const prev = process.env['SITE_URL'];
    try {
      delete process.env['SITE_URL'];
      expect(loadConfig().indexable).toBe(false);
      process.env['SITE_URL'] = '  ';
      expect(loadConfig().indexable).toBe(false);
      process.env['SITE_URL'] = 'https://example.ca/';
      expect(loadConfig()).toMatchObject({ indexable: true, siteUrl: 'https://example.ca' });
    } finally {
      if (prev === undefined) delete process.env['SITE_URL'];
      else process.env['SITE_URL'] = prev;
    }
  });
});
