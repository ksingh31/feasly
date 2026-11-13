#!/usr/bin/env tsx
/**
 * #490: real HTTP 404 for unknown URLs.
 *
 * staticwebapp.config.json has no navigationFallback (it answered every
 * unknown path with HTTP 200 — soft 404s); unknown paths hit
 * `responseOverrides.404 → /404.html` instead. This copies the prerendered
 * branded page (`404/index.html`, from prerender-routes.txt) to a flat
 * `404.html` at the output root: SWA resolves the root-level file for
 * unknown paths at any depth (the nested `/404/index.html` target failed
 * for multi-segment paths in the SWA emulator).
 *
 * Fails the build when the prerendered page is missing, so the override can
 * never point at nothing.
 *
 * Config (env, optional):
 *   SEO_OUTPUT_DIR   output directory (default dist/web/browser)
 *
 * Usage: tsx apps/web/scripts/build-404-page.ts
 */
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = join(SCRIPT_DIR, '..', 'dist', 'web', 'browser');

/** Flat file the SWA 404 override rewrites to (relative to the output root). */
export const NOT_FOUND_PAGE_FILE = '404.html';

/** Copies `<outputDir>/404/index.html` to `<outputDir>/404.html`; returns the target path. */
export function build404Page(outputDir: string = process.env['SEO_OUTPUT_DIR'] ?? DEFAULT_OUTPUT_DIR): string {
  const source = join(outputDir, '404', 'index.html');
  if (!existsSync(source)) {
    throw new Error(
      `build-404-page: ${source} not found — /404 must stay in prerender-routes.txt`,
    );
  }
  const target = join(outputDir, NOT_FOUND_PAGE_FILE);
  copyFileSync(source, target);
  return target;
}

// Run when executed directly (not when imported by the spec).
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`build-404-page: wrote ${build404Page()}`);
}
