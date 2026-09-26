#!/usr/bin/env node
/**
 * SEO-08: CLI entry for the performance-budget gate.
 *
 * Measures the production bundle (apps/web/dist/web/browser) against
 * apps/web/budgets.json and fails (exit 1) on hard budget violations:
 *   - initial JS > 200 KB gzipped
 *   - any prerendered page's image weight > 500 KB
 *
 * Buy-back rule (AC4): if initial JS grew > 5 KB gzipped versus the baseline
 * in budgets.json, prints a BUYBACK_NOTICE marker (exit 0 — the CI workflow
 * turns this into a PR bot comment, not a failure).
 *
 * Usage: node apps/web/tools/check-perf-budgets.mjs [--dist <dir>] [--web <dir>]
 * Local: npm run build --workspace @feasly/web -- --configuration=production
 *        && node apps/web/tools/check-perf-budgets.mjs
 */
import { join, dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadBudgets, measureDist, checkBudgets } from './perf-budgets.mjs';

const TOOLS_DIR = dirname(new URL(import.meta.url).pathname);
const WEB_DIR = join(TOOLS_DIR, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const webDir = resolve(arg('--web', WEB_DIR));
const distDir = resolve(arg('--dist', join(webDir, 'dist', 'web', 'browser')));

const budgets = loadBudgets(webDir);
if (!existsSync(distDir)) {
  console.error(`check-perf-budgets: dist not found at ${distDir}`);
  console.error('Build first: npm run build --workspace @feasly/web -- --configuration=production');
  process.exit(2);
}

const measurement = measureDist(distDir);
console.log(`initial JS (gzipped): ${measurement.jsInitialGzipKb.toFixed(2)} KB (budget ${budgets.assets.jsInitialGzipKb} KB)`);
const heavyPages = measurement.pages.filter((p) => p.imageWeightKb > 1);
if (heavyPages.length > 0) {
  console.log('heaviest pages by image weight:');
  for (const p of [...heavyPages].sort((a, b) => b.imageWeightKb - a.imageWeightKb).slice(0, 10)) {
    console.log(`  ${p.route}: ${p.imageWeightKb.toFixed(2)} KB (budget ${budgets.assets.imageWeightPerPageKb} KB)`);
  }
} else {
  console.log('no page carries more than 1 KB of images');
}

const { violations, buybackNotice, buybackGrowthKb } = checkBudgets(budgets, measurement);

if (buybackNotice) {
  console.log(
    `BUYBACK_NOTICE: initial JS grew +${buybackGrowthKb} KB gzipped vs baseline ` +
      `(${budgets.buyback.baselineJsInitialGzipKb} KB). Per the buy-back rule in budgets.json, ` +
      'note the tradeoff in the PR description and update the baseline if accepted.',
  );
}

if (violations.length > 0) {
  console.error('\nPERF BUDGET VIOLATIONS:');
  for (const v of violations) {
    console.error(`  ${v.metric}: ${v.actual} ${v.unit} > budget ${v.budget} ${v.unit}`);
  }
  process.exit(1);
}

console.log('\nAll performance budgets pass.');
