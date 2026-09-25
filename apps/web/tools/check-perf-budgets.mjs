#!/usr/bin/env node
/**
 * Performance-budget gate (FE8-003).
 *
 * Reads budgets from apps/web/budgets.json (config — never hardcoded here) and
 * asserts the measurable ones against the production build:
 *   1. Initial JS (gzipped) <= budgets.json jsInitialGzipKB. "Initial" is the
 *      set of scripts + stylesheets referenced by the built index.html — i.e.
 *      what the browser actually fetches on first load.
 *   2. Per-page image weight <= budgets.json perPageImageWeightKB, for every
 *      prerendered HTML page: the images that page references.
 *   3. Font loading uses font-display: swap (Google Fonts `display=swap`),
 *      so there is no invisible-text flash on slow connections.
 *
 * LCP / INP / CLS and the slow-4G hero-text trace need a real browser and are
 * enforced by the Lighthouse gate (FE0-006) where Chrome is available; this
 * script reports them as not-measurable-here rather than failing.
 *
 * Usage: node apps/web/tools/check-perf-budgets.mjs   (from the repo root;
 *   paths resolve from the script location, so any cwd works).
 * Requires a production build first: `npm run build --workspace=@feasly/web
 * -- --configuration=production`. Skips (exit 0) when dist/ is absent.
 * Tests: node --test apps/web/tools/check-perf-budgets.test.mjs
 */
import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = dirname(fileURLToPath(import.meta.url)); // apps/web/tools
const ROOT = join(WEB_DIR, '..', '..', '..'); // repo root
export const DIST_DIR = join(ROOT, 'apps', 'web', 'dist', 'web', 'browser');

const KB = 1024;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg']);

export function gzipKB(file) {
  return gzipSync(readFileSync(file)).length / KB;
}

/** Scripts + stylesheets referenced by the built index.html (the initial load set). */
export function initialAssets(indexHtml, distDir) {
  const assets = new Set();
  for (const m of indexHtml.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
    const url = m[1];
    if (/^https?:/.test(url) || url.startsWith('data:')) continue;
    const file = join(distDir, url.replace(/^\//, ''));
    if (existsSync(file) && statSync(file).isFile()) assets.add(file);
  }
  return assets;
}

/** Images referenced by one prerendered HTML page (<img> + og:/twitter: image). */
export function pageImages(html, distDir) {
  const imgs = new Set();
  const collect = (url) => {
    if (/^https?:/.test(url) || url.startsWith('data:')) return;
    const file = join(distDir, url.replace(/^\//, ''));
    if (existsSync(file) && IMAGE_EXTS.has(extname(file).toLowerCase())) imgs.add(file);
  };
  for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/g)) collect(m[1]);
  for (const m of html.matchAll(
    /<meta[^>]+(?:property|name)="(?:og:image|twitter:image)"[^>]+content="([^"]+)"/g,
  ))
    collect(m[1]);
  return imgs;
}

/**
 * Run the budget checks against a build output directory.
 * @returns {{failures: string[], notes: string[], initialGzipKB: number}}
 */
export function checkPerfBudgets(budgets, distDir) {
  const failures = [];
  const notes = [];

  const indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8');

  // 1. Initial JS (gzipped).
  const assets = initialAssets(indexHtml, distDir);
  let initialGzipKB = 0;
  for (const f of assets) initialGzipKB += gzipKB(f);
  notes.push(
    `initial load ${initialGzipKB.toFixed(1)}KB gzipped ` +
      `(budget ${budgets.jsInitialGzipKB}KB across ${assets.size} assets).`,
  );
  if (initialGzipKB > budgets.jsInitialGzipKB) {
    failures.push(
      `initial JS ${initialGzipKB.toFixed(1)}KB gzipped exceeds budget ${budgets.jsInitialGzipKB}KB ` +
        `(budgets.json jsInitialGzipKB). Note the tradeoff in the PR description.`,
    );
  }

  // 2. Per-page image weight.
  const pages = readdirSync(distDir).filter((f) => f.endsWith('.html'));
  for (const page of pages) {
    const html = readFileSync(join(distDir, page), 'utf8');
    const imgs = pageImages(html, distDir);
    let weightKB = 0;
    for (const f of imgs) weightKB += statSync(f).size / KB;
    if (imgs.size) {
      notes.push(`${page}: ${imgs.size} images, ${weightKB.toFixed(1)}KB (budget ${budgets.perPageImageWeightKB}KB).`);
    }
    if (weightKB > budgets.perPageImageWeightKB) {
      failures.push(
        `${page}: image weight ${weightKB.toFixed(1)}KB exceeds budget ${budgets.perPageImageWeightKB}KB ` +
          `(budgets.json perPageImageWeightKB).`,
      );
    }
  }

  // 3. font-display: swap — either the Google Fonts stylesheet URL carries
  // display=swap, or the build inlined @font-face blocks (Angular font
  // inlining) and every one of them declares font-display: swap.
  const fontLinks = [...indexHtml.matchAll(/<link[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /fonts\.googleapis\.com/.test(tag) && /rel="stylesheet"/.test(tag))
    .map((tag) => tag.match(/href="([^"]*)"/)[1]);
  const inlinedFaces = [...indexHtml.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
  if (fontLinks.length === 0 && inlinedFaces.length === 0) {
    notes.push('no font stylesheets or @font-face blocks in built index.html — font check skipped.');
  } else {
    const withoutSwap = fontLinks.filter((u) => !/[?&]display=swap/.test(u));
    const facesWithoutSwap = inlinedFaces.filter((b) => !/font-display\s*:\s*swap/i.test(b));
    if (withoutSwap.length) {
      failures.push(
        `font stylesheet without display=swap: ${withoutSwap.join(', ')} — ` +
          `add display=swap to avoid invisible-text flashes on slow connections.`,
      );
    }
    if (facesWithoutSwap.length) {
      failures.push(
        `${facesWithoutSwap.length} inlined @font-face block(s) without font-display: swap — ` +
          `invisible-text flashes possible on slow connections.`,
      );
    }
    if (!withoutSwap.length && !facesWithoutSwap.length) {
      notes.push(
        `font-display: swap confirmed (${fontLinks.length} stylesheet link(s), ` +
          `${inlinedFaces.length} inlined @font-face block(s)).`,
      );
    }
  }

  // 4. Lab metrics need a browser.
  notes.push(
    `LCP<=${budgets.lcpSeconds}s / INP<=${budgets.inpMs}ms / CLS<=${budgets.cls} and the slow-4G ` +
      `hero-text trace (<=${budgets.heroTextVisibleSlow4GSeconds}s) need a real browser; ` +
      `enforced by the Lighthouse gate (FE0-006) where Chrome is available.`,
  );

  return { failures, notes, initialGzipKB };
}

function main() {
  if (!existsSync(DIST_DIR)) {
    console.log('perf-budgets: no production build found at apps/web/dist/web/browser — skipping.');
    process.exit(0);
  }
  const budgets = JSON.parse(readFileSync(join(WEB_DIR, '..', 'budgets.json'), 'utf8'));
  const { failures, notes } = checkPerfBudgets(budgets, DIST_DIR);
  for (const n of notes) console.log(`perf-budgets: ${n}`);
  if (failures.length) {
    for (const f of failures) console.error(`::error::perf-budgets: ${f}`);
    process.exit(1);
  }
  console.log('perf-budgets: OK — measurable budgets hold.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
