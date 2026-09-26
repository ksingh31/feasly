#!/usr/bin/env node
/**
 * SEO-08: generates the LHCI config from budgets.json (single source of truth).
 *
 * Thresholds, web-vital limits, and asset budgets are read from
 * apps/web/budgets.json so the CI gate and the local budget check can never
 * drift apart. Audit URLs come from perf-audit-urls.mjs.
 *
 * Usage: node apps/web/tools/gen-lighthouserc.mjs --base <url> --out <file>
 *   --base  audit target origin (local serve URL or a live preview URL)
 *   --out   where to write the generated JSON (default: stdout)
 *   --runs  numberOfRuns per URL (default 3; median is asserted)
 *
 * The generated config uses startServerCommand only for local bases
 * (http://localhost:*); for live preview URLs it audits directly.
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadBudgets } from './perf-budgets.mjs';
import { auditRoutes } from './perf-audit-urls.mjs';

const TOOLS_DIR = dirname(new URL(import.meta.url).pathname);
const WEB_DIR = join(TOOLS_DIR, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export function genConfig({ base, runs = 3, webDir = WEB_DIR }) {
  const b = loadBudgets(webDir);
  const origin = base.replace(/\/$/, '');
  const urls = auditRoutes().map((r) => origin + r);
  const local = /^http:\/\/localhost(:\d+)?$/.test(origin);
  const port = local ? Number(new URL(origin).port || 8931) : 8931;

  const collect = { url: urls, numberOfRuns: runs };
  if (local) {
    collect.startServerCommand = `node ${join(webDir, 'tools', 'serve-dist.mjs')} --port ${port} --dist ${join(webDir, 'dist', 'web', 'browser')}`;
    collect.startServerReadyPattern = 'serving';
    collect.startServerReadyTimeout = 30000;
  }

  return {
    ci: {
      collect: {
        ...collect,
        settings: {
          preset: 'desktop',
          chromeFlags: '--no-sandbox --headless=new --disable-dev-shm-usage',
          // Prerendered pages are static; a single warm pass is enough.
          skipAudits: ['screenshot-thumbnails'],
        },
      },
      assert: {
        assertions: {
          'categories:performance': ['error', { minScore: b.lighthouseCategories.performance / 100 }],
          'categories:accessibility': ['error', { minScore: b.lighthouseCategories.accessibility / 100 }],
          'categories:best-practices': ['error', { minScore: b.lighthouseCategories.bestPractices / 100 }],
          'categories:seo': ['error', { minScore: b.lighthouseCategories.seo / 100 }],
          'largest-contentful-paint': ['error', { maxNumericValue: b.webVitals.lcpMs, aggregationMethod: 'median-run' }],
          'cumulative-layout-shift': ['error', { maxNumericValue: b.webVitals.cls, aggregationMethod: 'median-run' }],
          'total-blocking-time': ['error', { maxNumericValue: b.webVitals.tbtMs, aggregationMethod: 'median-run' }],
          // INP has no stable Lighthouse audit id (experimental-interaction-to-next-paint
          // is not recognized by LHCI 0.14.0): TBT above is the enforced lab proxy
          // for the budgets.json INP target.
          'resource-summary:script:size': [
            'error',
            { maxNumericValue: b.assets.jsInitialGzipKb * 1024, aggregationMethod: 'median-run' },
          ],
          'resource-summary:image:size': [
            'error',
            { maxNumericValue: b.assets.imageWeightPerPageKb * 1024, aggregationMethod: 'median-run' },
          ],
        },
      },
      upload: { target: 'temporary-public-storage' },
    },
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith('gen-lighthouserc.mjs');
if (isMain) {
  const base = arg('--base', 'http://localhost:8931');
  const runs = Number(arg('--runs', '3'));
  const out = arg('--out', '');
  const json = JSON.stringify(genConfig({ base, runs }), null, 2) + '\n';
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
}
