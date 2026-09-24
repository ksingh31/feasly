import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
/**
 * Regression guard for the missing-SPA-fallback bug found by browser QA
 * (2026-09-24): without `navigationFallback` in staticwebapp.config.json,
 * deep links and refreshes on /estimate/*, /privacy, and /terms served the
 * raw Azure Static Web Apps 404 page instead of the app. The app's own
 * wildcard route already redirects unknown paths to the landing page, but it
 * can only run if the host rewrites those requests to index.html first.
 */
describe('staticwebapp.config.json SPA fallback', () => {
    const configPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'public', 'staticwebapp.config.json');
    const publicDir = dirname(configPath);
    it('exists and is valid JSON', () => {
        expect(existsSync(configPath)).toBe(true);
        expect(() => JSON.parse(readFileSync(configPath, 'utf8'))).not.toThrow();
    });
    it('rewrites all non-file routes to /index.html', () => {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(config.navigationFallback?.rewrite).toBe('/index.html');
    });
    it('never rewrites the SEO files or static assets', () => {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        const exclude = config.navigationFallback?.exclude ?? [];
        expect(exclude).toContain('/robots.txt');
        expect(exclude).toContain('/sitemap.xml');
        expect(exclude.some((pattern) => pattern.startsWith('/assets'))).toBe(true);
    });
    it('every literal excluded path exists in public/', () => {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        const literal = (config.navigationFallback?.exclude ?? []).filter((pattern) => !pattern.includes('*'));
        for (const path of literal) {
            expect(existsSync(join(publicDir, path))).toBe(true);
        }
    });
});
