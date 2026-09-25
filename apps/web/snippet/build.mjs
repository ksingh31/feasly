#!/usr/bin/env node
/**
 * Builds apps/web/snippet/loader.js into the versioned, minified file the
 * builders paste:
 *
 *   apps/web/public/embed/v<major>/loader.js   (gitignored, served same-origin)
 *
 * - Version is read from FEASLY_LOADER_VERSION in loader.js (single source).
 * - esbuild minifies; the build FAILS if the minified file exceeds the 5 KB
 *   budget (story constraint: the snippet must stay tiny).
 * - Run from the web prebuild; also safe to run standalone from apps/web.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/web/snippet
const SRC = join(HERE, 'loader.js');
const BUDGET_BYTES = 5 * 1024;

const source = readFileSync(SRC, 'utf8');
const versionMatch = source.match(/FEASLY_LOADER_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/);
if (!versionMatch) {
  throw new Error('loader.js must define FEASLY_LOADER_VERSION as a semver string');
}
const version = versionMatch[1];
const major = version.split('.')[0];

const outDir = join(HERE, '..', 'public', 'embed', `v${major}`);
mkdirSync(outDir, { recursive: true });

const result = esbuild.transformSync(source, {
  minify: true,
  target: 'es2019',
  legalComments: 'none',
  banner: `/*! Feasly embed loader v${version} | install: docs/embed-install.md */`,
});
const bytes = Buffer.byteLength(result.code, 'utf8');
if (bytes > BUDGET_BYTES) {
  throw new Error(
    `embed loader budget exceeded: ${bytes} bytes minified (budget ${BUDGET_BYTES}). Shrink loader.js.`,
  );
}

const outFile = join(outDir, 'loader.js');
writeFileSync(outFile, result.code);
console.log(`[embed-loader] v${version} -> public/embed/v${major}/loader.js (${bytes} bytes)`);
