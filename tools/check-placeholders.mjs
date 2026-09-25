#!/usr/bin/env node
/**
 * Placeholder sweep (HRD-05, acceptance criterion 4).
 *
 * Fails (exit 1) when production paths reference unfinished placeholders:
 *   PLACEHOLDER | TODO(launch) | FIXME(launch) | karanbirsingh667@gmail.com
 *
 * Known placeholders are allowlisted in tools/placeholder-allowlist.txt —
 * each entry carries the reason and the unblock condition. The sweep catches
 * NEW forgotten placeholders; the allowlist documents the intentional ones
 * (cost-data calibration, tenant domain, site URL, ops inbox — all blocked
 * on Karan's decisions, all tracked in docs/launch-checklist.md).
 *
 * Test/spec/seed files are always excluded — the standing test email lives
 * there by design.
 *
 * Proven to bite by apps/web/tools/check-placeholders.spec.ts (vitest).
 *
 * Usage: node tools/check-placeholders.mjs (paths resolve from the script
 * location, so any cwd works).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TOOLS_DIR, '..'); // repo root

export const PLACEHOLDER_PATTERNS = [
  { name: 'PLACEHOLDER', re: /PLACEHOLDER/ },
  { name: 'TODO(launch)', re: /TODO\(launch\)/ },
  { name: 'FIXME(launch)', re: /FIXME\(launch\)/ },
  { name: 'test email', re: /karanbirsingh667@gmail\.com/ },
];

/** Extensions scanned (code, templates, config, docs that ship). */
const SCAN_EXTS = new Set([
  '.ts', '.html', '.js', '.mjs', '.cjs', '.json', '.scss', '.css',
]);

/** Always excluded: tests, specs, seeds, fixtures, generated files, the sweep itself. */
export function isExcluded(rel) {
  return (
    rel.includes('node_modules') ||
    rel.includes('/dist/') ||
    rel === 'tools/check-placeholders.mjs' ||
    rel === 'tools/placeholder-allowlist.txt' ||
    /\.spec\.ts$/.test(rel) ||
    /\.test\.ts$/.test(rel) ||
    /\/seed[^/]*\.ts$/.test(rel) ||
    /\/fixtures\//.test(rel) ||
    /\/generated\//.test(rel) ||
    rel.startsWith('plan/')
  );
}

export function loadAllowlist(root = ROOT) {
  const allowlistPath = join(root, 'tools', 'placeholder-allowlist.txt');
  if (!existsSync(allowlistPath)) return [];
  const entries = [];
  for (const line of readFileSync(allowlistPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // Format: <path-substring> :: <pattern-name> :: <reason>
    const [pathSub, patternName] = t.split('::').map((s) => s.trim());
    entries.push({ pathSub, patternName });
  }
  return entries;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
      walk(p, out);
    } else if (SCAN_EXTS.has(extname(p))) {
      out.push(p);
    }
  }
  return out;
}

/** Run the sweep against a repo root. Returns the failure descriptions. */
export function checkPlaceholders(root = ROOT) {
  const allowlist = loadAllowlist(root);
  const failures = [];
  for (const abs of walk(root)) {
    const rel = relative(root, abs);
    if (isExcluded(rel)) continue;
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const { name, re } of PLACEHOLDER_PATTERNS) {
        if (!re.test(line)) continue;
        const allowed = allowlist.some(
          (a) =>
            rel.includes(a.pathSub) &&
            (a.patternName === '*' || a.patternName === name),
        );
        if (!allowed) {
          failures.push(`${rel}:${i + 1} [${name}]: ${line.trim().slice(0, 120)}`);
        }
      }
    });
  }
  return failures;
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  const failures = checkPlaceholders();
  if (failures.length > 0) {
    console.error('');
    console.error(`PLACEHOLDER SWEEP FAILED (${failures.length} unallowlisted):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error('');
    console.error(
      'If a hit is intentional, add it to tools/placeholder-allowlist.txt with',
    );
    console.error('the reason + unblock condition. Otherwise, swap the placeholder.');
    console.error('');
    process.exit(1);
  }
  console.log('Placeholder sweep: no unallowlisted placeholders. OK.');
}
