#!/usr/bin/env node
/**
 * SEO-08: performance-budget measurement + evaluation.
 *
 * Single source of truth is apps/web/budgets.json. This module:
 *   - measures a production dist dir (gzipped initial JS, per-page image weight)
 *   - evaluates the measurement against the budgets, returning violations
 *
 * Pure functions (except loadBudgets) so the gate is unit-testable:
 * the "gate bites" fixture tests live in perf-budgets.spec.ts.
 *
 * No dependencies — node builtins only.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const TOOLS_DIR = dirname(new URL(import.meta.url).pathname);
const WEB_DIR = join(TOOLS_DIR, '..');

/** Load and lightly validate budgets.json. Throws on missing/invalid. */
export function loadBudgets(webDir = WEB_DIR) {
  const raw = readFileSync(join(webDir, 'budgets.json'), 'utf8');
  const b = JSON.parse(raw);
  for (const key of ['assets', 'webVitals', 'lighthouseCategories', 'buyback']) {
    if (!b[key] || typeof b[key] !== 'object') {
      throw new Error(`budgets.json: missing or invalid "${key}" section`);
    }
  }
  return b;
}

/** Recursively collect files under dir. Returns absolute paths. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/** Extract script src values from an HTML string. */
export function extractScriptSrcs(html) {
  const srcs = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) srcs.push(m[1]);
  return srcs;
}

/** Extract image URLs from img/srcset tags in an HTML string. */
export function extractImageUrls(html) {
  const urls = new Set();
  const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
  const srcsetRe = /srcset=["']([^"']+)["']/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) urls.add(m[1]);
  while ((m = srcsetRe.exec(html)) !== null) {
    for (const part of m[1].split(',')) {
      const url = part.trim().split(/\s+/)[0];
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

/** Resolve a URL found in a page's HTML to a file under distDir. Null if external/unresolvable. */
function resolveAsset(distDir, pageDir, url) {
  if (!url || /^(https?:|data:|blob:)|\/\//.test(url)) return null;
  const clean = url.split(/[?#]/)[0];
  const abs = clean.startsWith('/')
    ? join(distDir, clean.slice(1))
    : resolve(pageDir, clean);
  if (!abs.startsWith(distDir) || !existsSync(abs) || !statSync(abs).isFile()) return null;
  return abs;
}

export function gzipBytes(buf) {
  return gzipSync(buf).length;
}

/**
 * Measure a production dist dir.
 * Returns { jsInitialGzipKb, pages: [{ route, imageWeightKb }] }.
 */
export function measureDist(distDir) {
  distDir = resolve(distDir);
  const rootIndex = join(distDir, 'index.html');
  if (!existsSync(rootIndex)) {
    throw new Error(`measureDist: no index.html in ${distDir} — build the production bundle first`);
  }
  const rootHtml = readFileSync(rootIndex, 'utf8');
  const jsFiles = new Set();
  for (const src of extractScriptSrcs(rootHtml)) {
    const f = resolveAsset(distDir, distDir, src);
    if (f && f.endsWith('.js')) jsFiles.add(f);
  }
  let jsGzip = 0;
  for (const f of jsFiles) jsGzip += gzipBytes(readFileSync(f));

  const pages = [];
  for (const f of walk(distDir)) {
    if (!f.endsWith('/index.html') && f !== rootIndex) continue;
    const pageDir = dirname(f);
    const route = '/' + pageDir.slice(distDir.length + 1).replace(/\\/g, '/');
    const html = readFileSync(f, 'utf8');
    const seen = new Set();
    let bytes = 0;
    for (const url of extractImageUrls(html)) {
      const asset = resolveAsset(distDir, pageDir, url);
      if (asset && !seen.has(asset)) {
        seen.add(asset);
        bytes += statSync(asset).size;
      }
    }
    pages.push({ route: route === '/' ? '/' : route.replace(/\/$/, ''), imageWeightKb: bytes / 1024 });
  }
  pages.sort((a, b) => (a.route < b.route ? -1 : 1));

  return { jsInitialGzipKb: jsGzip / 1024, pages };
}

/**
 * Evaluate a measurement against budgets.
 * Returns { violations, buybackNotice, buybackGrowthKb }.
 * violations: [{ metric, actual, budget, unit }] — hard gate failures.
 * buybackNotice: true when JS grew > noteThresholdKb vs baseline (bot comment, not a fail).
 */
export function checkBudgets(budgets, measurement) {
  const violations = [];
  const jsBudget = budgets.assets.jsInitialGzipKb;
  if (measurement.jsInitialGzipKb > jsBudget) {
    violations.push({
      metric: 'js-initial-gzip',
      actual: round2(measurement.jsInitialGzipKb),
      budget: jsBudget,
      unit: 'KB',
    });
  }
  const imgBudget = budgets.assets.imageWeightPerPageKb;
  for (const page of measurement.pages) {
    if (page.imageWeightKb > imgBudget) {
      violations.push({
        metric: `image-weight:${page.route}`,
        actual: round2(page.imageWeightKb),
        budget: imgBudget,
        unit: 'KB',
      });
    }
  }
  const baseline = budgets.buyback.baselineJsInitialGzipKb;
  const growthKb = measurement.jsInitialGzipKb - baseline;
  const buybackNotice = baseline > 0 && growthKb > budgets.buyback.noteThresholdKb;
  return { violations, buybackNotice, buybackGrowthKb: round2(growthKb) };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
