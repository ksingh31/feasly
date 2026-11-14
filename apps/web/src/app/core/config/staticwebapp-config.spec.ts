import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routes } from '../../app.routes';

/**
 * Guards the Azure Static Web Apps routing config.
 *
 * - 2026-09-24 (browser QA): deep links and refreshes on client-only routes
 *   must serve the SPA shell, never the raw SWA 404 page.
 * - #490: unknown paths must return a real HTTP 404 (no soft 404s). So there
 *   is NO `navigationFallback` (it answers every unmatched path with 200);
 *   client-only routes are an explicit allow-list of `rewrite: /index.html`
 *   rules, prerendered routes are served as files, and everything else hits
 *   `responseOverrides.404` → `/404.html` (postbuild copy of the prerendered
 *   branded /404 page) with status 404.
 * - SEO-01: `trailingSlash` is deliberately NOT set — it is global (it would
 *   301 assets, /robots.txt, /sitemap.xml, and /api/* POSTs) and SWA redirect
 *   targets are static strings, so the trailing-slash 301s are per-slug exact
 *   rules for every prerendered community page (see SEO.md "Trailing-slash
 *   policy").
 */

interface SwaRoute {
  route: string;
  rewrite?: string;
  redirect?: string;
  statusCode?: number;
  headers?: Record<string, string>;
}

interface SwaConfig {
  navigationFallback?: unknown;
  trailingSlash?: string;
  routes?: SwaRoute[];
  responseOverrides?: Record<string, { rewrite?: string; statusCode?: number }>;
}

describe('staticwebapp.config.json routing', () => {
  const configPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'public',
    'staticwebapp.config.json',
  );
  const publicDir = dirname(configPath);

  const readConfig = (): SwaConfig => JSON.parse(readFileSync(configPath, 'utf8')) as SwaConfig;

  const prerenderRoutes = (): string[] =>
    readFileSync(join(publicDir, '..', 'prerender-routes.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

  /** SWA semantics: first matching rule wins; a trailing `/*` matches below that segment. */
  const matchRule = (path: string): SwaRoute | undefined =>
    (readConfig().routes ?? []).find((rule) =>
      rule.route.endsWith('/*')
        ? path.startsWith(rule.route.slice(0, -1))
        : rule.route === path,
    );

  it('exists and is valid JSON', () => {
    expect(existsSync(configPath)).toBe(true);
    expect(() => JSON.parse(readFileSync(configPath, 'utf8'))).not.toThrow();
  });

  it('has no navigationFallback — it would serve unknown paths as HTTP 200 (#490)', () => {
    // navigationFallback rewrites every unmatched path to index.html with
    // status 200, so search engines saw soft 404s. SPA deep links are an
    // explicit allow-list of `rewrite` routes instead (see below).
    expect(readConfig().navigationFallback).toBeUndefined();
  });

  it('serves unknown paths as HTTP 404 with the prerendered branded 404 page (#490)', () => {
    const override = readConfig().responseOverrides?.['404'];
    expect(override?.rewrite).toBe('/404.html');
    expect(override?.statusCode).toBe(404);
    // /404.html is a postbuild copy of the prerendered /404 route
    // (scripts/build-404-page.ts), so crawlers get the branded page without
    // running JS.
    expect(prerenderRoutes()).toContain('/404');
  });

  it('every client-only app route deep-links via an index.html rewrite (#490)', () => {
    const prerendered = new Set(prerenderRoutes().map((r) => r.replace(/\/+$/, '') || '/'));
    const samplePaths: string[] = [];
    for (const route of routes) {
      const path = route.path ?? '';
      if (path === '**') continue;
      // Community pages are prerendered per slug (checked below); an unknown
      // slug is deliberately a real 404.
      if (path === 'communities/:slug') continue;
      const sample = `/${path.replace(/:[^/]+/g, 'sample')}`.replace(/\/$/, '') || '/';
      if (prerendered.has(sample)) continue;
      samplePaths.push(sample);
      if (route.children?.length || route.loadChildren) samplePaths.push(`${sample}/child`);
    }
    expect(samplePaths.length).toBeGreaterThan(0);
    for (const sample of samplePaths) {
      expect(matchRule(sample)?.rewrite, `no index.html rewrite for ${sample}`).toBe(
        '/index.html',
      );
    }
  });

  it('never rewrites SEO files, static assets, /api/*, or unknown paths to the SPA shell', () => {
    // A rewrite here would hide a missing file / stale linked API backend
    // behind index.html (P0 2026-09-26) or reintroduce soft 404s (#490).
    for (const path of [
      '/api/estimates',
      '/assets/app.js',
      '/robots.txt',
      '/sitemap.xml',
      '/llms.txt',
      '/llms-full.txt',
      '/this-page-does-not-exist',
      '/communities/not-a-real-community/',
      '/guides/not-a-real-guide',
    ]) {
      expect(matchRule(path)?.rewrite, `${path} must not be rewritten`).toBeUndefined();
    }
  });

  it('keeps the embed frame-ancestors override on the rewritten /embed/* route', () => {
    const rule = matchRule('/embed/tenant-key');
    expect(rule?.route).toBe('/embed/*');
    expect(rule?.rewrite).toBe('/index.html');
    expect(rule?.headers?.['Content-Security-Policy']).toContain('frame-ancestors');
  });

  it('serves the builder embed loader as a static script, not the SPA shell (#490)', () => {
    // Route rewrites apply before static files, so `/embed/*` → index.html
    // would otherwise swallow public/embed/v<major>/loader.js (built by
    // snippet/build.mjs) and break every builder embed. The versioned loader
    // folder needs its own earlier rule with no rewrite.
    const loaderSrc = readFileSync(join(publicDir, '..', 'snippet', 'loader.js'), 'utf8');
    const major = loaderSrc.match(/FEASLY_LOADER_VERSION\s*=\s*'(\d+)\./)?.[1];
    expect(major, 'FEASLY_LOADER_VERSION not found in snippet/loader.js').toBeDefined();
    const rule = matchRule(`/embed/v${major}/loader.js`);
    expect(rule?.route).toBe(`/embed/v${major}/*`);
    expect(rule?.rewrite).toBeUndefined();
    expect(rule?.redirect).toBeUndefined();
    expect(rule?.headers?.['Content-Type']).toContain('javascript');
  });

  it('does not set the global trailingSlash flag', () => {
    const config = readConfig();
    // Deliberate: trailing-slash 301s are per-slug exact rules (community
    // pages) in `routes`, not the global flag. A global flag would 301
    // assets, /robots.txt, /sitemap.xml, and /api/* POSTs (see SEO.md).
    expect(config.trailingSlash).toBeUndefined();
  });

  it('301-redirects every prerendered community slug to its trailing-slash form (SEO-01 AC6)', () => {
    const rules = readConfig().routes ?? [];
    // Every /communities/{slug}/ in prerender-routes.txt must have an exact
    // 301 from the non-trailing-slash form (SWA wildcards would loop, so the
    // rules are per-slug — see SEO.md).
    const slugs = prerenderRoutes()
      .filter((line) => line.startsWith('/communities/') && line !== '/communities/')
      .map((line) => line.replace(/\/+$/, ''));
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      const rule = rules.find((r) => r.route === slug);
      expect(rule, `missing 301 for ${slug}`).toBeDefined();
      expect(rule?.redirect).toBe(`${slug}/`);
      expect(rule?.statusCode).toBe(301);
    }
  });
});
