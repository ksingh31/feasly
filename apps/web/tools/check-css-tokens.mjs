#!/usr/bin/env node
/**
 * Every `var(--x)` without a fallback must name a defined custom property (issue #676).
 *
 * An undefined custom property with no fallback makes the declaration invalid at
 * computed-value time, so it silently becomes `inherit`/initial — a background turns
 * transparent, a colour inherits. Nothing else catches that, so this tripwire fails
 * (exit 1) when any SCSS file under `apps/web/src` uses `var(--name)` (no fallback)
 * and `--name` is never defined.
 *
 * "Defined" means any of:
 *   - a `--name: …` declaration in any SCSS file under `apps/web/src` (global
 *     `styles.scss` or a component-local scope);
 *   - set at runtime from TS/HTML: `style.setProperty('--name', …)` or a
 *     `[style.--name]` binding.
 *
 * `var(--name, fallback)` is not checked here: it always renders.
 *
 * Usage: node apps/web/tools/check-css-tokens.mjs
 * Tests: vitest run tools/check-css-tokens.test.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = dirname(fileURLToPath(import.meta.url)); // apps/web/tools
const ROOT = join(WEB_DIR, '..', '..', '..'); // repo root
export const SRC_DIR = join(ROOT, 'apps', 'web', 'src');

/**
 * Strip block comments and `//` line comments (not `://` inside url()),
 * keeping newlines so reported line numbers stay right.
 */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Custom properties declared in SCSS (`--name:`). */
export function findDefinitions(scss) {
  const out = new Set();
  for (const m of stripComments(scss).matchAll(/(?<![\w-])(--[\w-]+)\s*:/g)) out.add(m[1]);
  return out;
}

/** Custom properties set at runtime from TS / templates. */
export function findRuntimeDefinitions(code) {
  const out = new Set();
  for (const m of code.matchAll(/setProperty\(\s*['"`](--[\w-]+)['"`]/g)) out.add(m[1]);
  for (const m of code.matchAll(/\[style\.(--[\w-]+)\]/g)) out.add(m[1]);
  return out;
}

/**
 * `var(--name)` references with no fallback, with their 1-based line numbers.
 * @returns {{ name: string, line: number }[]}
 */
export function findBareReferences(scss) {
  const src = stripComments(scss);
  const out = [];
  for (const m of src.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ name: m[1], line });
  }
  return out;
}

function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * Scan a source tree.
 * @returns {string[]} one message per undefined bare reference (empty = OK)
 */
export function scan(dir = SRC_DIR) {
  const scssFiles = walk(dir, ['.scss']);
  const codeFiles = walk(dir, ['.ts', '.html']).filter((f) => !f.endsWith('.spec.ts'));
  const defined = new Set();
  for (const f of scssFiles) for (const n of findDefinitions(readFileSync(f, 'utf8'))) defined.add(n);
  for (const f of codeFiles) {
    for (const n of findRuntimeDefinitions(readFileSync(f, 'utf8'))) defined.add(n);
  }
  const problems = [];
  for (const f of scssFiles) {
    const rel = relative(ROOT, f).split(sep).join('/');
    for (const { name, line } of findBareReferences(readFileSync(f, 'utf8'))) {
      if (!defined.has(name)) problems.push(`${rel}:${line} var(${name}) — ${name} is not defined`);
    }
  }
  return problems;
}

function main() {
  const problems = scan();
  if (problems.length) {
    console.error('check-css-tokens: FAIL — var() references to undefined tokens:\n');
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      '\nAn undefined token with no fallback silently falls back to inherit/initial.',
    );
    console.error('Use an existing token from apps/web/src/styles.scss (docs/design-tokens.md).');
    process.exit(1);
  }
  console.log('check-css-tokens: OK');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
