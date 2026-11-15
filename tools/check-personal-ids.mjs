#!/usr/bin/env node
/**
 * Personal-identifier guard (#758).
 *
 * The repo is public. This check fails (exit 1) when any tracked text file
 * contains a personal identifier from the denylist — the owner's personal
 * email, the Azure subscription id, the Azure (home) tenant id.
 *
 * The denylist is stored as SHA-256 hashes of the lower-cased identifier, so
 * the check itself never publishes what it guards. Every email-shaped and
 * GUID-shaped token in every scanned file is lower-cased, hashed, and
 * compared against the denylist.
 *
 * Known, load-bearing occurrences (the seeded super_admin in applied
 * migrations, its mirror in the schema-repair SQL, the ops-inbox default) are
 * allowlisted per file in tools/personal-id-allowlist.txt, keyed by the
 * hash prefix so an allowlist entry covers exactly one identifier.
 *
 * Unlike the placeholder sweep, tests, fixtures and docs are scanned too —
 * a public repo leaks from a test file just as well.
 *
 * Adding an identifier: `printf %s '<value>' | tr A-Z a-z | sha256sum` and
 * append the hash to DENYLIST_SHA256 below (never the value).
 *
 * Proven to bite by apps/web/tools/check-personal-ids.spec.ts (vitest).
 * Runs in CI via tools/check-placeholders.mjs (same CLI invocation).
 *
 * Usage: node tools/check-personal-ids.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TOOLS_DIR, '..');

/** SHA-256 (hex) of each lower-cased personal identifier. */
export const DENYLIST_SHA256 = Object.freeze([
  // owner's personal email address
  'fa90efc9f9ba1672a44e348dcea0ca5779f611f1b198988a9f698819c4750bc5',
  // Azure subscription id
  'cffa34f5f1b7a9e69b8bf7807b17287a5ca10e68454d241cc276feab4bafa18b',
  // Azure home tenant id (the subscription's directory)
  '4eb2da8ee8eee0e03e6e98ca55d111aae86d15c58a210d741d860b7acc1d47f0',
]);

/** Hash prefix length used in reports and allowlist entries. */
export const HASH_PREFIX_LEN = 12;

const TOKEN_RES = [
  /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/g, // email
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, // GUID
];

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', '.angular', 'coverage', 'out-tsc',
  'test-results', 'playwright-report',
]);
const MAX_BYTES = 2 * 1024 * 1024;

export function sha256(value) {
  return createHash('sha256').update(value.toLowerCase()).digest('hex');
}

export function loadAllowlist(root = ROOT) {
  const p = join(root, 'tools', 'personal-id-allowlist.txt');
  if (!existsSync(p)) return [];
  const entries = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // Format: <exact repo-relative path> :: <hash prefix> :: <reason>
    const [path, prefix, reason] = t.split('::').map((s) => s.trim());
    if (!path || !prefix || !reason) {
      throw new Error(`personal-id-allowlist: malformed entry (need path :: hash :: reason): ${t}`);
    }
    entries.push({ path, prefix });
  }
  return entries;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(e)) walk(p, out);
    } else if (st.isFile() && st.size <= MAX_BYTES) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Scan a repo root. Returns failure descriptions (never the identifier
 * itself — only its hash prefix).
 */
export function checkPersonalIds(root = ROOT, denylist = DENYLIST_SHA256) {
  const deny = new Set(denylist);
  const allowlist = loadAllowlist(root);
  const failures = [];
  for (const abs of walk(root)) {
    const rel = relative(root, abs).split(sep).join('/');
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((line, i) => {
      const lower = line.toLowerCase();
      const seen = new Set();
      for (const re of TOKEN_RES) {
        for (const m of lower.matchAll(re)) {
          const h = sha256(m[0]);
          if (!deny.has(h) || seen.has(h)) continue;
          seen.add(h);
          const prefix = h.slice(0, HASH_PREFIX_LEN);
          const allowed = allowlist.some((a) => a.path === rel && h.startsWith(a.prefix));
          if (!allowed) failures.push(`${rel}:${i + 1} [personal id ${prefix}]`);
        }
      }
    });
  }
  return failures;
}

/** CLI body, shared with tools/check-placeholders.mjs. Returns exit code. */
export function runCli(root = ROOT) {
  const failures = checkPersonalIds(root);
  if (failures.length > 0) {
    console.error('');
    console.error(`PERSONAL-ID GUARD FAILED (${failures.length} unallowlisted):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error('');
    console.error('A denylisted personal identifier (owner email, Azure subscription/tenant id)');
    console.error('is in a tracked file. Replace it with a role address or placeholder');
    console.error('(`owner`, `<subscription-id>`, `gh variable get AZURE_SUBSCRIPTION_ID`).');
    console.error('Only a load-bearing runtime value may be allowlisted, in');
    console.error('tools/personal-id-allowlist.txt, with the reason.');
    console.error('');
    return 1;
  }
  console.log('Personal-id guard: no unallowlisted personal identifiers. OK.');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
