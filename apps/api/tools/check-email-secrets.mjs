#!/usr/bin/env node
/**
 * Email secrets-hygiene tripwire (story email/01, acceptance criterion 4).
 *
 * Fails (exit 1) when the email module (or its config surface) contains a
 * committed secret: provider tokens, connection strings, private keys.
 * Provider credentials must arrive via Key Vault references — never the repo.
 *
 * Heuristic, intentionally narrow: string literals that LOOK like real
 * secrets. Placeholders ('feasly.example', 'your-token', 'xxx', '…') are
 * ignored. Comments are stripped before scanning.
 *
 * Usage: node apps/api/tools/check-email-secrets.mjs (paths resolve from
 * the script location, so any cwd works).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(TOOLS_DIR, '..');
const SCAN_DIRS = [join(API_DIR, 'src', 'services', 'email')];
const SCAN_FILES = [join(API_DIR, 'src', 'config.ts')];

function allTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strip block + line comments without eating `//` inside string literals. */
function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const line of noBlock.split('\n')) {
    let quote = null;
    let cut = line.length;
    for (let i = 0; i < line.length - 1; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === '/' && line[i + 1] === '/') {
        cut = i;
        break;
      }
    }
    out.push(line.slice(0, cut));
  }
  return out.join('\n');
}

/** Placeholder-looking values are never flagged. */
function isPlaceholder(literal) {
  return /example|placeholder|your-|xxx+|\.\.\.|<[^>]+>|changeme/i.test(literal);
}

const SECRET_PATTERNS = [
  // Postmark-style server tokens assigned as literals.
  [/serverToken\s*:\s*(['"])([^'"]{12,})\1/, 'possible Postmark server token literal'],
  // Azure Communication Services connection strings.
  [/endpoint=https:\/\/[^'";\s]+;accesskey=[^'";\s]+/i, 'possible ACS connection string'],
  // Generic long opaque token assignments.
  [/\b(token|secret|password|apiKey)\s*[:=]\s*(['"])[A-Za-z0-9\-_]{20,}\2/, 'possible hardcoded credential'],
  // Private keys.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key material'],
];

const failures = [];

function scanFile(file) {
  const code = stripComments(readFileSync(file, 'utf8'));
  // Only inspect string literals — prose in identifiers can't be a secret.
  const literalRe = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;
  let m;
  while ((m = literalRe.exec(code)) !== null) {
    const literal = m[0];
    if (isPlaceholder(literal)) continue;
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(literal)) {
        failures.push(`${file}: ${label}: ${literal.slice(0, 40)}…`);
      }
    }
  }
}

for (const dir of SCAN_DIRS) {
  for (const file of allTsFiles(dir)) scanFile(file);
}
for (const file of SCAN_FILES) scanFile(file);

if (failures.length > 0) {
  console.error('email-secrets: committed secret suspected — credentials must come from Key Vault, never the repo:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('email-secrets: clean (no committed secrets in the email module).');
