/**
 * Bundle the Azure Functions trigger adapters into self-contained files.
 *
 * Why bundling: the Function App runs on Flex Consumption with no remote
 * build, and `Azure/functions-action` deploys `apps/api` as-is — there is no
 * node_modules on the server (see apps/api/README.md). Each adapter is
 * therefore bundled with its full dependency closure (zod, cost-engine,
 * drizzle-orm, pg, …) into a single CJS file next to its function.json:
 *
 *   src/functions/estimate.ts → estimate/index.js   (POST /api/v1/estimate)
 *   src/functions/leads.ts    → leads/index.js      (POST /api/v1/leads)
 *   src/functions/health.ts   → health/index.js     (GET /api/health, HRD-06)
 *   src/functions/magic-link-verify.ts  → magic-link-verify/index.js
 *     (GET /api/v1/magic-link/verify)
 *   src/functions/magic-link-reissue.ts → magic-link-reissue/index.js
 *     (POST /api/v1/magic-link/reissue)
 *   src/functions/events.ts   → events/index.js     (POST /api/v1/events)
 *   src/functions/privacy-export.ts        → privacy-export/index.js
 *     (GET /api/v1/privacy/export)
 *   src/functions/privacy-erase.ts         → privacy-erase/index.js
 *     (POST /api/v1/privacy/erase-requests)
 *   src/functions/privacy-erase-confirm.ts → privacy-erase-confirm/index.js
 *     (POST /api/v1/privacy/erase-requests/{requestId}/confirm)
 *   src/functions/narrative.ts              → narrative/index.js
 *     (POST /api/v1/estimates/{estimateId}/narrative)
 *   src/functions/communities-stats.ts    → communities-stats/index.js
 *     (GET /api/v1/communities/{slug}/stats)
 *   src/functions/unsubscribe-get.ts      → unsubscribe-get/index.js
 *     (GET /api/v1/unsubscribe/{token})
 *   src/functions/unsubscribe-post.ts     → unsubscribe-post/index.js
 *     (POST /api/v1/unsubscribe/{token})
 *   src/functions/nudge-timer.ts          → nudge-timer/index.js
 *     (Timer: hourly 24h nudge for unverified leads)
 *   src/functions/sandbox-purge-timer.ts  → sandbox-purge-timer/index.js
 *     (Timer: daily sandbox test-data purge, api-mcp/09)
 *   src/functions/api-keys.ts             → api-keys/index.js
 *     (GET|POST /api/v1/admin/api-keys)
 *   src/functions/api-keys-rotate.ts      → api-keys-rotate/index.js
 *     (POST /api/v1/admin/api-keys/{id}/rotate)
 *   src/functions/api-keys-revoke.ts      → api-keys-revoke/index.js
 *     (POST /api/v1/admin/api-keys/{id}/revoke)
 *   src/functions/embed-config.ts         → embed-config/index.js
 *     (GET /api/v1/embed/config)
 *   src/functions/properties-autocomplete.ts → properties-autocomplete/index.js
 *     (GET /api/v1/properties/autocomplete)
 *   src/functions/properties-lookup.ts       → properties-lookup/index.js
 *     (GET /api/v1/properties/lookup)
 *   src/functions/stripe-webhooks.ts         → stripe-webhooks/index.js
 *     (POST /api/v1/stripe/webhooks)
 *   src/functions/invoice-reviewer-timer.ts  → invoice-reviewer-timer/index.js
 *     (Timer: daily commission-invoice reviewer)
 *   src/functions/mcp.ts                    → mcp/index.js
 *     (POST /mcp/v1)
 *
 * Run: `npm run bundle:functions --workspace @feasly/api`
 * (cd.yml runs this before the Functions deploy; the outputs are gitignored).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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
];

for (const { entry, out } of targets) {
  await build({
    entryPoints: [join(root, entry)],
    outfile: join(root, out),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // config.ts inlines apps/api/package.json for the version — JSON is
    // bundled, never read from disk at runtime.
    loader: { '.json': 'json' },
    logLevel: 'info',
  });
  console.log(`bundled ${entry} -> ${out}`);
}
