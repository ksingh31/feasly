/**
 * #490: the flat 404.html the SWA 404 override rewrites to.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOT_FOUND_PAGE_FILE, build404Page } from './build-404-page.js';

const SPEC_DIR = dirname(fileURLToPath(import.meta.url));

describe('build-404-page (#490)', () => {
  it('copies the prerendered /404 page to a flat 404.html at the output root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-found-'));
    mkdirSync(join(dir, '404'));
    writeFileSync(join(dir, '404', 'index.html'), '<title>Page not found</title>');

    const target = build404Page(dir);

    expect(target).toBe(join(dir, '404.html'));
    expect(readFileSync(target, 'utf-8')).toBe('<title>Page not found</title>');
  });

  it('fails the build when the prerendered /404 page is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-found-'));
    expect(() => build404Page(dir)).toThrow(/prerender-routes\.txt/);
  });

  it('writes the file the staticwebapp.config.json 404 override points at', () => {
    const config = JSON.parse(
      readFileSync(join(SPEC_DIR, '..', 'public', 'staticwebapp.config.json'), 'utf-8'),
    ) as { responseOverrides?: Record<string, { rewrite?: string }> };
    expect(config.responseOverrides?.['404']?.rewrite).toBe(`/${NOT_FOUND_PAGE_FILE}`);
  });
});
