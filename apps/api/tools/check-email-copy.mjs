#!/usr/bin/env node
/**
 * Email copy lint (story email/01, acceptance criterion 5).
 *
 * Fails (exit 1) when any string literal in the email templates matches a
 * banned copy pattern: accuracy claims, promises the product can't keep, or
 * dollar figures in email copy (figures live in the report behind the
 * deterministic-math disclaimer).
 *
 * Patterns come from apps/api/src/services/email/banned-patterns.txt — the
 * single source of truth shared with apps/api/test/email.service.test.ts,
 * which asserts the same rules against RENDERED output.
 *
 * Usage: node apps/api/tools/check-email-copy.mjs (paths resolve from the
 * script location, so any cwd works).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const EMAIL_DIR = join(TOOLS_DIR, '..', 'src', 'services', 'email');
const PATTERNS_FILE = join(EMAIL_DIR, 'banned-patterns.txt');
const TEMPLATES_FILE = join(EMAIL_DIR, 'templates.ts');

function loadPatterns() {
  return readFileSync(PATTERNS_FILE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((source) => ({ source, re: new RegExp(source, 'i') }));
}

/** String literals with line numbers (comments stripped). */
function literalsWithLines(src) {
  // templates.ts carries no URL literals (boundary test forbids them), so
  // per-line // stripping can't eat a string's contents here.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const out = [];
  const literalRe = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  let m;
  while ((m = literalRe.exec(code)) !== null) {
    const line = code.slice(0, m.index).split('\n').length;
    out.push({ line, literal: m[0] });
  }
  return out;
}

const patterns = loadPatterns();
const literals = literalsWithLines(readFileSync(TEMPLATES_FILE, 'utf8'));
const failures = [];

for (const { line, literal } of literals) {
  for (const { source, re } of patterns) {
    if (re.test(literal)) {
      failures.push(`templates.ts:${line}: banned copy /${source}/ in ${literal.slice(0, 70)}…`);
    }
  }
}

if (failures.length > 0) {
  console.error('email-copy: banned phrase in template copy:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('email-copy: clean (no banned phrases in template copy).');
