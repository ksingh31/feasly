/**
 * Bundle-architecture guard (hardening for the 2026-09-25 worker OOM crash loop).
 *
 * Root cause of that incident: every function adapter used to be bundled with
 * its FULL dependency closure (~29MB each), so the Node worker parsed ~1.1GB
 * of duplicated JS at startup and died at the heap limit within seconds.
 * The fix (shared `apps/api/index.js` + tiny per-adapter shims) only works
 * while the bundler keeps every adapter external to the shared closure.
 *
 * This check runs the real bundler (`tools/bundle-functions.mjs`) and fails
 * if:
 *   - the shared bundle `apps/api/index.js` is missing or over budget
 *     (currently ~30MB; budget 60MB), or
 *   - any per-adapter `apps/api/<adapter>/index.js` is missing, over the
 *     shim budget (100KB — a regressed full bundle would be ~29MB), or does
 *     not require() the shared bundle.
 *
 * The generated bundles are deleted afterwards: they are gitignored build
 * artifacts, and later CI steps (e.g. the placeholder sweep) must never
 * scan generated code. CD's deploy job re-runs the bundler itself.
 *
 * Run: `node tools/check-function-bundle.mjs` from apps/api (also wired into
 * `npm run lint`, which CI runs).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_BUNDLE = join(root, 'index.js');
// The shared closure is ~30MB today; 60MB leaves headroom without hiding a
// duplicated-closure regression (38 x 30MB was the 1.1GB that killed workers).
const SHARED_BUDGET_BYTES =
  Number(process.env.FUNCTION_BUNDLE_SHARED_BUDGET_MB ?? 60) * 1024 * 1024;
// Shims are ~2KB; 100KB budget fails loudly if an adapter ever inlines the
// full closure again (~29MB).
const SHIM_BUDGET_BYTES =
  Number(process.env.FUNCTION_BUNDLE_SHIM_BUDGET_KB ?? 100) * 1024;

const failures = [];

/** Directories with a function.json are deployed adapters. */
function listAdapters() {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'function.json')))
    .map((e) => e.name)
    .sort();
}

function checkBundles() {
  if (!existsSync(SHARED_BUNDLE)) {
    failures.push('shared bundle apps/api/index.js was not produced');
  } else {
    const size = statSync(SHARED_BUNDLE).size;
    if (size > SHARED_BUDGET_BYTES) {
      failures.push(
        `shared bundle apps/api/index.js is ${(size / 1048576).toFixed(1)}MB, ` +
          `over the ${(SHARED_BUDGET_BYTES / 1048576).toFixed(0)}MB budget`,
      );
    }
  }

  // Every adapter directory must have a tiny shim (not a full bundle).
  const adapters = listAdapters();
  if (adapters.length === 0) {
    failures.push('no adapter directories with function.json found');
  }

  for (const adapter of adapters) {
    const shim = join(root, adapter, 'index.js');
    if (!existsSync(shim)) {
      failures.push(`${adapter}/index.js missing (bundler did not emit a shim)`);
      continue;
    }
    const size = statSync(shim).size;
    if (size > SHIM_BUDGET_BYTES) {
      failures.push(
        `${adapter}/index.js is ${(size / 1024).toFixed(0)}KB, over the ` +
          `${SHIM_BUDGET_BYTES / 1024}KB shim budget — the adapter is bundling ` +
          `its full dependency closure again (the 2026-09-25 OOM pattern)`,
      );
      continue;
    }
    const source = readFileSync(shim, 'utf8');
    if (
      !source.includes('require("../index")') &&
      !source.includes("require('../index')")
    ) {
      failures.push(`${adapter}/index.js does not require() the shared bundle`);
    }
  }
  return adapters.length;
}

/** Remove the bundler's outputs so later CI steps never scan generated code. */
function removeGeneratedBundles() {
  for (const adapter of listAdapters()) {
    rmSync(join(root, adapter, 'index.js'), { force: true });
  }
  rmSync(SHARED_BUNDLE, { force: true });
}

// Build with the same bundler CD uses, so this checks the real outputs.
try {
  execFileSync('node', [join(root, 'tools', 'bundle-functions.mjs')], {
    cwd: root,
    stdio: 'pipe',
    timeout: 300_000,
  });
} catch (error) {
  console.error(`::error::bundle-functions.mjs failed: ${error.message}`);
  process.exit(1);
}

let adapterCount = 0;
try {
  adapterCount = checkBundles();
} finally {
  removeGeneratedBundles();
}

if (failures.length > 0) {
  for (const f of failures) console.error(`::error::${f}`);
  console.error(
    `\ncheck-function-bundle: FAILED (${failures.length} problem(s), ` +
      `${adapterCount} adapters checked)`,
  );
  process.exit(1);
}
console.log(
  `check-function-bundle: OK (${adapterCount} adapter shims within budget; ` +
    `generated bundles removed)`,
);
