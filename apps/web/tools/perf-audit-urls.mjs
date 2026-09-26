#!/usr/bin/env node
/**
 * SEO-08: deterministic audit-URL sampler.
 *
 * Reads apps/web/prerender-routes.txt and emits the Lighthouse audit set:
 *   '/' + '/how-it-works' + '/faq' (when present) + the first 3
 *   '/communities/<slug>' routes alphabetically. '/communities/' is included
 *   automatically once the index route exists in prerender-routes.txt.
 *
 * Deterministic (no random sampling) so baselines stay comparable run to run.
 *
 * Usage: node apps/web/tools/perf-audit-urls.mjs --base https://example.com
 * Prints one absolute URL per line.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const TOOLS_DIR = dirname(new URL(import.meta.url).pathname);
const WEB_DIR = join(TOOLS_DIR, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export function auditRoutes(routesFile = join(WEB_DIR, 'prerender-routes.txt')) {
  const routes = readFileSync(routesFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((r) => (r === '/' ? '/' : r.replace(/\/$/, '')));

  const picked = [];
  const take = (r) => {
    if (routes.includes(r) && !picked.includes(r)) picked.push(r);
  };
  take('/');
  take('/how-it-works');
  take('/faq');
  take('/communities');
  const community = routes
    .filter((r) => r.startsWith('/communities/') && r !== '/communities/')
    .sort()
    .slice(0, 3);
  for (const r of community) take(r);
  return picked;
}

const isMain = process.argv[1] && process.argv[1].endsWith('perf-audit-urls.mjs');
if (isMain) {
  const base = arg('--base', 'http://localhost:8931').replace(/\/$/, '');
  for (const r of auditRoutes()) console.log(base + r);
}
