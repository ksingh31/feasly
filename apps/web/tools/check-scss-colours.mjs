#!/usr/bin/env node
/**
 * No colour literals in feature SCSS (UI kit, issue #494).
 *
 * docs/design/portal-ui-kit.md §1: only `styles.scss` defines colours; feature
 * stylesheets use tokens (`var(--…)`). This tripwire fails (exit 1) when a
 * hex (`#fff`, `#a1b2c3`, `#a1b2c3cc`) or numeric `rgb()/rgba()/hsl()/hsla()`
 * literal appears in a declaration value in `apps/web/src/app/features/**\/*.scss`.
 *
 * Existing violations live in `tools/scss-colour-allowlist.txt` as
 * `<repo-relative path> <count>`. The baseline is a ratchet — it may only go down:
 *   - a file not in the allowlist with any literal          → FAIL
 *   - a file whose count is above its baseline               → FAIL
 *   - a file whose count is below its baseline               → FAIL (lower the baseline)
 *   - an entry whose file has zero literals or no longer exists → FAIL (remove it)
 * So a migrated page can't regress, and the allowlist always matches reality.
 *
 * `--update` rewrites the allowlist to the current counts, but only when every
 * change is a decrease/removal; it refuses to add files or raise counts.
 *
 * Usage: node apps/web/tools/check-scss-colours.mjs [--update]
 * Tests: vitest run tools/check-scss-colours.test.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = dirname(fileURLToPath(import.meta.url)); // apps/web/tools
const ROOT = join(WEB_DIR, '..', '..', '..'); // repo root
const FEATURES_DIR = join(ROOT, 'apps', 'web', 'src', 'app', 'features');
export const ALLOWLIST = join(WEB_DIR, 'scss-colour-allowlist.txt');

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/g;
const COLOUR_FN = /\b(?:rgba?|hsla?)\(\s*[-+.\d]/gi;

/** Strip block comments and `//` line comments (not `://` inside url()). */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Find colour literals in declaration values (`prop: value;` and SCSS
 * `$var: value;`), so id selectors like `#main {` never count.
 * @returns {string[]} the literals found, in order
 */
export function findColourLiterals(scss) {
  const src = stripComments(scss);
  const found = [];
  for (const decl of src.matchAll(/[$\w-]+\s*:\s*([^;{}]+)(?=[;}])/g)) {
    const value = decl[1];
    for (const m of value.matchAll(HEX)) found.push(m[0]);
    for (const m of value.matchAll(COLOUR_FN)) found.push(m[0].replace(/\s+/g, ''));
  }
  return found;
}

/** Parse `<path> <count>` lines; `#` comments and blank lines ignored. */
export function parseAllowlist(text) {
  const map = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(\d+)$/.exec(line);
    if (!m) throw new Error(`scss-colour-allowlist: malformed line "${line}"`);
    map.set(m[1], Number(m[2]));
  }
  return map;
}

/** Serialise counts back to allowlist text (sorted, stable). */
export function formatAllowlist(counts) {
  const header = [
    '# Feature SCSS files that still contain colour literals (hex / rgb / hsl).',
    '# Ratchet baseline for tools/check-scss-colours.mjs — counts may only go DOWN.',
    '# Migrate a page to tokens, then lower its count (or delete the line at zero).',
    '# `node apps/web/tools/check-scss-colours.mjs --update` does this for you.',
  ];
  const lines = [...counts]
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, n]) => `${p} ${n}`);
  return `${[...header, ...lines].join('\n')}\n`;
}

/**
 * Compare current counts against the baseline.
 * @param {Map<string, number>} current - path -> literal count (every scanned file)
 * @param {Map<string, number>} baseline - path -> allowed count
 * @returns {{ regressions: string[], stale: string[] }}
 *   regressions: new or increased literals (never auto-fixable);
 *   stale: baseline entries that are too high or obsolete (fix with --update).
 */
export function compareToBaseline(current, baseline) {
  const regressions = [];
  const stale = [];
  for (const [path, n] of current) {
    if (n === 0) continue;
    const allowed = baseline.get(path);
    if (allowed === undefined) {
      regressions.push(`${path}: ${n} colour literal(s) — feature SCSS must use tokens (var(--…)).`);
    } else if (n > allowed) {
      regressions.push(`${path}: ${n} colour literal(s), baseline allows ${allowed} — use tokens.`);
    }
  }
  for (const [path, allowed] of baseline) {
    const n = current.get(path);
    if (n === undefined) {
      stale.push(`${path}: in the allowlist but the file no longer exists — remove the line.`);
    } else if (n === 0) {
      stale.push(`${path}: no colour literals left — remove it from the allowlist.`);
    } else if (n < allowed) {
      stale.push(`${path}: ${n} colour literal(s), baseline says ${allowed} — lower it to ${n}.`);
    }
  }
  return { regressions, stale };
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.scss')) out.push(full);
  }
  return out;
}

export function scanFeatures(dir = FEATURES_DIR) {
  const current = new Map();
  for (const file of walk(dir)) {
    const rel = relative(ROOT, file).split(sep).join('/');
    current.set(rel, findColourLiterals(readFileSync(file, 'utf8')).length);
  }
  return current;
}

function main() {
  const update = process.argv.includes('--update');
  const baseline = existsSync(ALLOWLIST)
    ? parseAllowlist(readFileSync(ALLOWLIST, 'utf8'))
    : new Map();
  const current = scanFeatures();
  const { regressions, stale } = compareToBaseline(current, baseline);

  if (regressions.length) {
    console.error('check-scss-colours: FAIL — colour literals in feature SCSS:\n');
    for (const r of regressions) console.error(`  ${r}`);
    console.error(
      '\nOnly apps/web/src/styles.scss defines colours (docs/design/portal-ui-kit.md §1).',
    );
    console.error('Use a token like var(--status-success-fg); the allowlist only shrinks.');
    process.exit(1);
  }
  if (stale.length) {
    if (update) {
      writeFileSync(ALLOWLIST, formatAllowlist(current));
      console.log(`check-scss-colours: allowlist lowered (${stale.length} change(s)).`);
      return;
    }
    console.error('check-scss-colours: FAIL — the allowlist is out of date (good news):\n');
    for (const s of stale) console.error(`  ${s}`);
    console.error('\nRun `node apps/web/tools/check-scss-colours.mjs --update` and commit it.');
    process.exit(1);
  }
  const total = [...baseline.values()].reduce((a, b) => a + b, 0);
  console.log(`check-scss-colours: OK (${baseline.size} file(s), ${total} literal(s) left to migrate)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
