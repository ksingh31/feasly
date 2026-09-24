import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the missing-SPA-fallback bug found by browser QA
 * (2026-09-24): without `navigationFallback` in staticwebapp.config.json,
 * deep links and refreshes on /estimate/*, /privacy, and /terms served the
 * raw Azure Static Web Apps 404 page instead of the app.
 *
 * SEO-01: platform 404s are overridden to `/index.html` so the branded
 * `/404` SPA route renders; `trailingSlash` is deliberately NOT set —
 * it is global (it would 301 assets, /robots.txt, /sitemap.xml, and
 * /api/* POSTs) and SWA redirect targets are static strings, so per-slug
 * 301s ship with the community-page story instead (see SEO.md).
 */
describe('staticwebapp.config.json SPA fallback', () => {
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

  it('exists and is valid JSON', () => {
    expect(existsSync(configPath)).toBe(true);
    expect(() => JSON.parse(readFileSync(configPath, 'utf8'))).not.toThrow();
  });

  it('rewrites all non-file routes to /index.html', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      navigationFallback?: { rewrite?: string; exclude?: string[] };
    };
    expect(config.navigationFallback?.rewrite).toBe('/index.html');
  });

  it('never rewrites the SEO files or static assets', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      navigationFallback?: { rewrite?: string; exclude?: string[] };
    };
    const exclude = config.navigationFallback?.exclude ?? [];
    expect(exclude).toContain('/robots.txt');
    expect(exclude).toContain('/sitemap.xml');
    expect(exclude.some((pattern) => pattern.startsWith('/assets'))).toBe(true);
  });

  it('overrides platform 404s to the SPA shell (branded /404 route)', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      responseOverrides?: { '404'?: { rewrite?: string } };
    };
    expect(config.responseOverrides?.['404']?.rewrite).toBe('/index.html');
  });

  it('does not set the global trailingSlash flag', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      trailingSlash?: string;
    };
    // Deliberate: trailing-slash 301s are per-route (community slugs) and
    // ship with the community-page story. A global flag would 301 assets,
    // /robots.txt, /sitemap.xml, and /api/* POSTs (see SEO.md).
    expect(config.trailingSlash).toBeUndefined();
  });

  it('every literal excluded path exists in public/', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      navigationFallback?: { rewrite?: string; exclude?: string[] };
    };
    const literal = (config.navigationFallback?.exclude ?? []).filter(
      (pattern) => !pattern.includes('*'),
    );
    for (const path of literal) {
      expect(existsSync(join(publicDir, path))).toBe(true);
    }
  });
});
