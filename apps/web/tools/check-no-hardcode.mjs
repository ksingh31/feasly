#!/usr/bin/env node
/**
 * No-hardcode tripwire (FE0-002).
 *
 * Fails (exit 1) when tunable literals appear in apps/web/src/app:
 *   1. Absolute URLs (https?://) in .ts/.html — endpoints belong in config.
 *   2. Long string literals (>= 50 chars) / long text runs (>= 60 chars) —
 *      user-facing copy belongs in ConfigService, not templates or code.
 *   3. Magic numbers (2+ digits, or decimals) in .ts — tunables belong in config.
 *
 * This is a tripwire, not a proof: when a hit is genuinely not tunable
 * (e.g. a dev-facing log line), shorten it or add the file to
 * tools/hardcode-allowlist.txt WITH a reason. `*.spec.ts` is always excluded.
 *
 * Usage: node apps/web/tools/check-no-hardcode.mjs   (from the repo root;
 *   paths resolve from the script location, so any cwd works)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = dirname(fileURLToPath(import.meta.url)); // apps/web/tools
const ROOT = join(WEB_DIR, '..', '..', '..'); // repo root
const APP_DIR = join(ROOT, 'apps', 'web', 'src', 'app');
const ALLOWLIST = join(WEB_DIR, 'hardcode-allowlist.txt');

const LONG_STRING = 50;
const LONG_TEXT = 60;

function loadAllowlist() {
  const lines = readFileSync(ALLOWLIST, 'utf8').split('\n');
  return new Set(
    lines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => join(ROOT, l)),
  );
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|html)$/.test(entry) && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/** Crude comment stripper: good enough for a lint tripwire. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function checkFile(full, rel, hits) {
  const raw = readFileSync(full, 'utf8');
  const src = stripComments(raw);
  const isHtml = full.endsWith('.html');

  // 1. Absolute URLs.
  for (const m of src.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    hits.push(`${rel}: hardcoded URL: ${m[0].slice(0, 60)}`);
  }

  // 2. Long copy strings: real string literals only (never spans of code
  // between two quotes). Single/double-quoted literals can't cross lines in
  // TS; template literals can, and a long one is almost always copy.
  if (!isHtml) {
    const seen = new Set();
    for (const m of src.matchAll(
      /'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*"|`(?:\\.|[^`\\])*`/g,
    )) {
      const literal = m[0].slice(1, -1);
      if (literal.length >= LONG_STRING && !seen.has(m[0])) {
        seen.add(m[0]);
        const preview = literal.replace(/\s+/g, ' ').slice(0, 60);
        hits.push(`${rel}: hardcoded copy (${literal.length} chars): "${preview}…"`);
      }
    }
  } else {
    const text = src.replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ');
    for (const chunk of text.split(/\s{2,}|\n/)) {
      const trimmed = chunk.trim();
      if (trimmed.length >= LONG_TEXT) {
        hits.push(`${rel}: hardcoded copy (${trimmed.length} chars): "${trimmed.slice(0, 60)}…"`);
        break; // one hit per template is enough signal
      }
    }
  }

  // 3. Magic numbers (TS only; templates use bindings for tunables).
  if (!isHtml) {
    for (const m of src.matchAll(/(?<![\w.])\d{2,}(?![\w.])|(?<![\w.])\d+\.\d+(?![\w.])/g)) {
      hits.push(`${rel}: magic number: ${m[0]}`);
    }
  }
}

const allowlist = loadAllowlist();
const hits = [];
for (const full of walk(APP_DIR)) {
  if (allowlist.has(full)) continue;
  checkFile(full, relative(ROOT, full), hits);
}

if (hits.length > 0) {
  console.error('check-no-hardcode: FAIL — tunable literals found in apps/web/src/app:\n');
  for (const h of hits) console.error(`  ${h}`);
  console.error(
    '\nMove tunables into ConfigService (apps/web/public/assets/config/app-config.json),',
  );
  console.error('or add the file to apps/web/tools/hardcode-allowlist.txt with a reason.');
  process.exit(1);
}
console.log('check-no-hardcode: OK');
