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
 *   src/functions/magic-link-verify.ts  → magic-link-verify/index.js
 *     (GET /api/v1/magic-link/verify)
 *   src/functions/magic-link-reissue.ts → magic-link-reissue/index.js
 *     (POST /api/v1/magic-link/reissue)
 *   src/functions/privacy-export.ts        → privacy-export/index.js
 *     (GET /api/v1/privacy/export)
 *   src/functions/privacy-erase.ts         → privacy-erase/index.js
 *     (POST /api/v1/privacy/erase-requests)
 *   src/functions/privacy-erase-confirm.ts → privacy-erase-confirm/index.js
 *     (POST /api/v1/privacy/erase-requests/{requestId}/confirm)
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
  { entry: 'src/functions/magic-link-verify.ts', out: 'magic-link-verify/index.js' },
  { entry: 'src/functions/magic-link-reissue.ts', out: 'magic-link-reissue/index.js' },
  { entry: 'src/functions/privacy-export.ts', out: 'privacy-export/index.js' },
  { entry: 'src/functions/privacy-erase.ts', out: 'privacy-erase/index.js' },
  {
    entry: 'src/functions/privacy-erase-confirm.ts',
    out: 'privacy-erase-confirm/index.js',
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
