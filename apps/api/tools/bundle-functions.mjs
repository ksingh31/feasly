/**
 * Bundle the Azure Functions trigger adapters.
 *
 * Memory architecture (fix for the 2026-09-25 worker OOM crash-loop):
 * the Function App runs on Flex Consumption with a 2048MB instance and the
 * Node.js worker loads EVERY function at startup into a single process.
 * Each adapter used to be bundled with its FULL dependency closure
 * (28.9MB each — the entire API surface via src/index.ts), so the worker
 * had to parse ~1.1GB of duplicated JS at startup and died at ~1.5GB heap
 * within seconds (38 functions x ~80MB heap each).
 *
 * Now the shared closure is bundled ONCE into apps/api/index.js and each
 * adapter is a tiny shim that require()s it:
 *
 *   src/index.ts            → index.js            (shared closure, ~29MB, parsed once)
 *   src/functions/health.ts → health/index.js     (shim, a few KB)
 *   ... (38 adapters)
 *
 * Why this works: the worker parses the 29MB closure a single time
 * (~90MB heap) instead of 38 times (~3GB). No source changes were needed —
 * adapters keep importing from the package public surface (`../index`);
 * esbuild just leaves that import external and it resolves to the deployed
 * shared bundle at runtime.
 *
 * Deploy note: `Azure/functions-action` ships the whole apps/api directory,
 * so the shared index.js deploys automatically. The per-adapter
 * `require("../index")` resolves to apps/api/index.js from every
 * apps/api/<adapter>/index.js (all adapter outputs sit one level deep,
 * hence the "../../index" -> "../index" normalization below).
 *
 * Run: `npm run bundle:functions --workspace @feasly/api`
 * (cd.yml runs this before the Functions deploy; the outputs are gitignored).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The barrel specifiers as written in adapter sources. Both resolve to
// src/index.ts at build time; both are left external so the adapters
// require the shared runtime bundle instead of inlining the closure.
const BARREL_SPECIFIERS = ['../index', '../../index'];

const sharedBuild = {
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // config.ts inlines apps/api/package.json for the version — JSON is
  // bundled, never read from disk at runtime.
  loader: { '.json': 'json' },
  logLevel: 'warning',
};

const targets = [
  { entry: 'src/functions/estimate.ts', out: 'estimate/index.js' },
  { entry: 'src/functions/leads.ts', out: 'leads/index.js' },
  { entry: 'src/functions/health.ts', out: 'health/index.js' },
  { entry: 'src/functions/magic-link-verify.ts', out: 'magic-link-verify/index.js' },
  { entry: 'src/functions/magic-link-reissue.ts', out: 'magic-link-reissue/index.js' },
  { entry: 'src/functions/events.ts', out: 'events/index.js' },
  { entry: 'src/functions/privacy-export.ts', out: 'privacy-export/index.js' },
  { entry: 'src/functions/privacy-erase.ts', out: 'privacy-erase/index.js' },
  {
    entry: 'src/functions/privacy-erase-confirm.ts',
    out: 'privacy-erase-confirm/index.js',
  },
  { entry: 'src/functions/narrative.ts', out: 'narrative/index.js' },
  {
    entry: 'src/functions/communities-stats.ts',
    out: 'communities-stats/index.js',
  },
  {
    entry: 'src/functions/unsubscribe-get.ts',
    out: 'unsubscribe-get/index.js',
  },
  {
    entry: 'src/functions/unsubscribe-post.ts',
    out: 'unsubscribe-post/index.js',
  },
  {
    entry: 'src/functions/nudge-timer.ts',
    out: 'nudge-timer/index.js',
  },
  {
    entry: 'src/functions/sandbox-purge-timer.ts',
    out: 'sandbox-purge-timer/index.js',
  },
  {
    entry: 'src/functions/api-keys.ts',
    out: 'api-keys/index.js',
  },
  {
    entry: 'src/functions/api-keys-rotate.ts',
    out: 'api-keys-rotate/index.js',
  },
  {
    entry: 'src/functions/api-keys-revoke.ts',
    out: 'api-keys-revoke/index.js',
  },
  {
    entry: 'src/functions/embed-config.ts',
    out: 'embed-config/index.js',
  },
  {
    entry: 'src/functions/properties-autocomplete.ts',
    out: 'properties-autocomplete/index.js',
  },
  {
    entry: 'src/functions/properties-lookup.ts',
    out: 'properties-lookup/index.js',
  },
  {
    entry: 'src/functions/openapi.ts',
    out: 'openapi/index.js',
  },
  {
    entry: 'src/functions/usage.ts',
    out: 'usage/index.js',
  },
  {
    entry: 'src/functions/funnels.ts',
    out: 'funnels/index.js',
  },
  {
    entry: 'src/functions/stripe-webhooks.ts',
    out: 'stripe-webhooks/index.js',
  },
  {
    entry: 'src/functions/invoice-reviewer-timer.ts',
    out: 'invoice-reviewer-timer/index.js',
  },
  {
    entry: 'src/functions/admin-auth-request.ts',
    out: 'admin-auth-request/index.js',
  },
  {
    entry: 'src/functions/admin-auth-verify.ts',
    out: 'admin-auth-verify/index.js',
  },
  {
    entry: 'src/functions/admin-auth-logout.ts',
    out: 'admin-auth-logout/index.js',
  },
  {
    entry: 'src/functions/admin-auth-me.ts',
    out: 'admin-auth-me/index.js',
  },
  {
    entry: 'src/functions/mcp.ts',
    out: 'mcp/index.js',
  },
  {
    entry: 'src/functions/admin-leads.ts',
    out: 'admin-leads/index.js',
  },
  {
    entry: 'src/functions/admin-calibration.ts',
    out: 'admin-calibration/index.js',
  },
  {
    entry: 'src/functions/admin-leads-detail.ts',
    out: 'admin-leads-detail/index.js',
  },
  {
    entry: 'src/functions/admin-leads-notes.ts',
    out: 'admin-leads-notes/index.js',
  },
  {
    entry: 'src/functions/admin-leads-status.ts',
    out: 'admin-leads-status/index.js',
  },
  {
    entry: 'src/functions/admin-leads-export.ts',
    out: 'admin-leads-export/index.js',
  },
  {
    entry: 'src/functions/admin-leads-quarantine-approve.ts',
    out: 'admin-leads-quarantine-approve/index.js',
  },
  {
    entry: 'src/functions/admin-leads-quarantine-discard.ts',
    out: 'admin-leads-quarantine-discard/index.js',
  },
  {
    entry: 'src/functions/admin-estimates-get.ts',
    out: 'admin-estimates-get/index.js',
  },
  {
    entry: 'src/functions/community-stats-refresh-timer.ts',
    out: 'community-stats-refresh-timer/index.js',
  },
  {
    entry: 'src/functions/sheets-sync-timer.ts',
    out: 'sheets-sync-timer/index.js',
  },
  {
    entry: 'src/functions/admin-community-stats-refresh.ts',
    out: 'admin-community-stats-refresh/index.js',
  },
  // phase-2 wiring: the five live-API endpoints the web app needs.
  {
    entry: 'src/functions/estimates-preview.ts',
    out: 'estimates-preview/index.js',
  },
  {
    entry: 'src/functions/reports-get.ts',
    out: 'reports-get/index.js',
  },
  {
    entry: 'src/functions/reports-revisions.ts',
    out: 'reports-revisions/index.js',
  },
  {
    entry: 'src/functions/callbacks.ts',
    out: 'callbacks/index.js',
  },
  {
    entry: 'src/functions/shares.ts',
    out: 'shares/index.js',
  },
];

// 1. Shared closure, bundled once.
await build(sharedBuild);
console.log('bundled src/index.ts -> index.js (shared)');

// 2. Tiny per-adapter shims; the barrel stays external.
for (const { entry, out } of targets) {
  await build({
    entryPoints: [join(root, entry)],
    outfile: join(root, out),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: BARREL_SPECIFIERS,
    loader: { '.json': 'json' },
    logLevel: 'warning',
  });

  // 3. Normalize the barrel require: every adapter output lives at
  // apps/api/<adapter>/index.js, so the shared bundle is always ../index.
  // (Adapters under src/functions/*/ import '../../index' as written;
  // esbuild preserves the specifier verbatim when external.)
  const outPath = join(root, out);
  const code = readFileSync(outPath, 'utf8');
  const normalized = code.split('require("../../index")').join('require("../index")');
  if (normalized !== code) writeFileSync(outPath, normalized);

  console.log(`bundled ${entry} -> ${out}`);
}
