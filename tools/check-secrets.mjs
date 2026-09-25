#!/usr/bin/env node
/**
 * check-secrets.mjs — HRD-07 secrets-hygiene gate.
 *
 * Scans for leaked secret material in two modes:
 *   --diff <range>      scan added lines of `git diff <range>` (PR/push gate)
 *   --diff-file <path>  scan a unified diff read from a file
 *   --stdin             scan a unified diff read from stdin (tests)
 *   --bundle <dir>      scan a built web bundle directory for secret patterns
 *
 * Exit codes: 0 = clean, 1 = violations found, 2 = usage/config error.
 * Violations print as GitHub `::error file=,line=::` annotations.
 *
 * Allowlist: tools/.secrets-allowlist (override with --allowlist <path>).
 * Every entry MUST have a `# reason` comment directly above it — the script
 * fails closed (exit 2) when an entry lacks one. Only test fixtures may be
 * allowlisted; a real credential is never allowlisted.
 *
 * NOTE on self-scanning: this file is itself scanned by the gate, so it must
 * never contain a literal secret-shaped string (e.g. a live-key prefix
 * followed by key material). Patterns are written to avoid self-matching.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

// ---------------------------------------------------------------------------
// Placeholder detection: values that are obviously not real credentials.
// ---------------------------------------------------------------------------
const PLACEHOLDER_CONTAINS = [
  'fake', 'example', 'placeholder', 'changeme', 'change-me', 'your-', 'your_',
  'xxx', 'redacted', 'dummy', 'sample', 'mock', 'todo', 'fixme', '<', '>',
  '${', '#{', 'secret-here', 'key-here', 'password-here', 'insert', 'replace',
  'todo(launch)',
];
const PLACEHOLDER_AFFIXES = [
  '_fake', 'fake_', '-fake', 'fake-', '_test', 'test_', '-test', 'test-',
  '_example', '_dummy', '_mock', '_placeholder',
];
const PLACEHOLDER_EXACT = new Set([
  '', '123', '1234', '12345', '123456', 'abc', 'abc123', 'password', 'secret',
  'pass', 'test', 'none', 'null', 'undefined', '***', '...', 'n/a', 'tbd',
]);

function isPlaceholder(value) {
  const v = String(value).trim().toLowerCase();
  if (PLACEHOLDER_EXACT.has(v)) return true;
  for (const s of PLACEHOLDER_CONTAINS) if (v.includes(s)) return true;
  for (const a of PLACEHOLDER_AFFIXES) if (v.includes(a)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Patterns. Each entry: { id, description, test(line) -> offending | null }.
// `test` returns the offending substring (for the report) or null.
// ---------------------------------------------------------------------------
const LIVE_KEY_RE = /sk_live_[A-Za-z0-9_-]{6,}/;
const TEST_KEY_RE = /sk_test_([A-Za-z0-9_-]{4,})/;
const WEBHOOK_SECRET_RE = /whsec_([A-Za-z0-9_-]{4,})/;
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const SLACK_TOKEN_RE = /xox[bpras]-[A-Za-z0-9-]{6,}/;
const ACS_ACCESSKEY_RE = /accesskey\s*=\s*["']?([^;"'`\s}]{4,})/i;
const DB_URL_PASSWORD_RE = /postgres(?:ql)?:\/\/[^/\s:]+:([^@\s/'"]{4,})@/i;

// Explicit secret-bearing variable names (from apps/api/src/config.ts).
// Matched only in NAME=value / NAME: value assignment form with a
// token-shaped value, so zod schemas and prose never match.
const SECRET_VARS = [
  'AZURE_CLIENT_SECRET',
  'EMAIL_POSTMARK_SERVER_TOKEN',
  'POSTMARK_SERVER_TOKEN',
  'POSTMARK_API_TOKEN',
  'EMAIL_ACS_CONNECTION_STRING',
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'ADMIN_API_KEY',
  'UNSUBSCRIBE_TOKEN_SECRET',
];
const SECRET_ASSIGN_RE = new RegExp(
  '\\b(' + SECRET_VARS.join('|') + ')\\s*[:=]\\s*["\']?([^"\'`\\s}>,]{4,})',
  'i',
);

function afterPrefix(line, re) {
  const m = line.match(re);
  return m ? m[1] : null;
}

const PATTERNS = [
  {
    id: 'stripe-live-key',
    description: 'Stripe live secret key — never commit, even a fake-looking one',
    test(line) {
      const m = line.match(LIVE_KEY_RE);
      return m ? m[0] : null; // always fails (HRD-07 AC1), no placeholder pass
    },
  },
  {
    id: 'stripe-test-key',
    description: 'Stripe test secret key with real-looking material',
    test(line) {
      const rest = afterPrefix(line, TEST_KEY_RE);
      return rest && !isPlaceholder(rest) ? 'sk_test_' + rest : null;
    },
  },
  {
    id: 'stripe-webhook-secret',
    description: 'Stripe webhook signing secret with real-looking material',
    test(line) {
      const rest = afterPrefix(line, WEBHOOK_SECRET_RE);
      return rest && !isPlaceholder(rest) ? 'whsec_' + rest : null;
    },
  },
  {
    id: 'private-key',
    description: 'PEM private key block',
    test(line) {
      const m = line.match(PRIVATE_KEY_RE);
      return m ? m[0] : null;
    },
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    test(line) {
      const m = line.match(SLACK_TOKEN_RE);
      return m ? m[0] : null;
    },
  },
  {
    id: 'acs-access-key',
    description: 'Azure Communication Services access key in a connection string',
    test(line) {
      const m = line.match(ACS_ACCESSKEY_RE);
      if (!m || isPlaceholder(m[1])) return null;
      return 'accesskey=' + m[1];
    },
  },
  {
    id: 'db-url-password',
    description: 'Database password embedded in a connection URL',
    test(line) {
      const m = line.match(DB_URL_PASSWORD_RE);
      if (!m || isPlaceholder(m[1])) return null;
      return '(password in URL)';
    },
  },
  {
    id: 'secret-assignment',
    description: 'Secret-bearing variable assigned a real-looking value',
    test(line) {
      const m = line.match(SECRET_ASSIGN_RE);
      if (!m) return null;
      let value = m[2].replace(/[;,]+$/, '');
      if (/[()]/.test(value)) return null; // code (e.g. zod schema), not a credential
      // DATABASE_URL carries the password inside the URL — judge the
      // password, not the whole URL.
      if (/^database_url$/i.test(m[1])) {
        const pm = value.match(/postgres(?:ql)?:\/\/[^/\s:]+:([^@\s/'"]+)@/i);
        if (pm && isPlaceholder(pm[1])) return null;
        if (!pm && isPlaceholder(value)) return null;
      } else if (isPlaceholder(value)) {
        return null;
      }
      return m[1] + '=<value>';
    },
  },
];

function scanLine(line) {
  const hits = [];
  for (const p of PATTERNS) {
    const offending = p.test(line);
    if (offending) hits.push({ id: p.id, description: p.description, offending });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Allowlist: path globs, each requiring a `# reason` comment above it.
// ---------------------------------------------------------------------------
function loadAllowlist(path) {
  if (!existsSync(path)) return [];
  const entries = [];
  let pendingReason = null;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) {
      pendingReason = pendingReason ? pendingReason + ' ' + line.slice(1).trim() : line.slice(1).trim();
      continue;
    }
    if (line === '') continue;
    if (!pendingReason) {
      console.error(
        `::error file=${relative(REPO_ROOT, path)}::allowlist entry "${line}" has no "# reason" comment above it — every entry must say why (HRD-07).`,
      );
      process.exit(2);
    }
    entries.push({ glob: line, reason: pendingReason });
    pendingReason = null;
  }
  return entries;
}

function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + esc + '$');
}

function isAllowlisted(relPath, allowlist) {
  const norm = relPath.split(sep).join('/');
  return allowlist.some((e) => globToRegExp(e.glob).test(norm));
}

// ---------------------------------------------------------------------------
// Diff scanning.
// ---------------------------------------------------------------------------
function parseDiff(diffText) {
  // Yields { file, line (new-file line number, may be null), text } for each
  // added line of each non-deleted file.
  const out = [];
  let file = null;
  let newLine = null;
  let skipFile = false;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null; newLine = null; skipFile = false;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      if (p === '/dev/null') { skipFile = true; continue; }
      file = p.startsWith('b/') ? p.slice(2) : p;
      continue;
    }
    if (raw.startsWith('Binary files ')) { skipFile = true; continue; }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { newLine = parseInt(hunk[1], 10); continue; }
    if (skipFile || file === null) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      out.push({ file, line: newLine, text: raw.slice(1) });
      if (newLine !== null) newLine += 1;
    } else if (raw.startsWith(' ') && newLine !== null) {
      newLine += 1;
    }
  }
  return out;
}

function getDiffText(range) {
  const r = spawnSync('git', ['diff', '--no-color', '--no-ext-diff', range, '--'], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(`::error::git diff failed for range "${range}": ${r.stderr.trim()}`);
    process.exit(2);
  }
  return r.stdout;
}

// ---------------------------------------------------------------------------
// Bundle scanning.
// ---------------------------------------------------------------------------
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf',
  '.eot', '.otf', '.mp4', '.webm', '.pdf', '.zip', '.gz', '.map',
]);

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

function scanBundle(dir) {
  const findings = [];
  const abs = resolve(REPO_ROOT, dir);
  if (!existsSync(abs)) {
    console.error(`::error::bundle directory not found: ${dir}`);
    process.exit(2);
  }
  const files = walkFiles(abs);
  let scanned = 0;
  for (const f of files) {
    const lower = f.toLowerCase();
    if ([...BINARY_EXT].some((e) => lower.endsWith(e))) continue;
    let text;
    try {
      const buf = readFileSync(f);
      if (buf.subarray(0, 8192).includes(0)) continue; // binary sniff
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    scanned += 1;
    const rel = relative(REPO_ROOT, f);
    text.split('\n').forEach((lineText, i) => {
      for (const hit of scanLine(lineText)) {
        findings.push({ file: rel, line: i + 1, text: lineText.trim().slice(0, 160), ...hit });
      }
    });
  }
  return { findings, scanned };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
function report(findings, scannedLabel) {
  if (findings.length === 0) {
    console.log(`secrets scan: clean (${scannedLabel})`);
    return 0;
  }
  for (const f of findings) {
    const loc = f.line ? `file=${f.file},line=${f.line}` : `file=${f.file}`;
    console.log(
      `::error ${loc}::[HRD-07 ${f.id}] ${f.description}: ${f.offending}` +
      (f.text ? ` — ${f.text}` : ''),
    );
  }
  console.log(
    `\nsecrets scan: ${findings.length} violation(s). ` +
    'Remove the credential from the diff/bundle; use a placeholder or an ' +
    'allowlisted test fixture instead. See docs/ops/secrets.md.',
  );
  return 1;
}

function main() {
  const args = process.argv.slice(2);
  let mode = null; let modeArg = null; let allowlistPath = join(HERE, '.secrets-allowlist');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--diff' || a === '--diff-file' || a === '--bundle' || a === '--allowlist') {
      const v = args[++i];
      if (!v) { console.error('::error::missing value for ' + a); process.exit(2); }
      if (a === '--allowlist') allowlistPath = resolve(REPO_ROOT, v);
      else { mode = a.slice(2); modeArg = v; }
    } else if (a === '--stdin') {
      mode = 'stdin';
    } else {
      console.error('::error::unknown arg: ' + a);
      process.exit(2);
    }
  }
  if (!mode) {
    console.error('::error::usage: check-secrets.mjs (--diff <range> | --diff-file <p> | --stdin | --bundle <dir>) [--allowlist <p>]');
    process.exit(2);
  }
  const allowlist = loadAllowlist(allowlistPath);

  if (mode === 'bundle') {
    const { findings, scanned } = scanBundle(modeArg);
    process.exit(report(findings.filter((f) => !isAllowlisted(f.file, allowlist)), `${scanned} text files in ${modeArg}`));
  }

  let diffText;
  if (mode === 'diff') diffText = getDiffText(modeArg);
  else if (mode === 'diff-file') diffText = readFileSync(resolve(REPO_ROOT, modeArg), 'utf8');
  else diffText = readFileSync(0, 'utf8'); // --stdin

  const findings = [];
  let addedLines = 0;
  for (const { file, line, text } of parseDiff(diffText)) {
    if (isAllowlisted(file, allowlist)) continue;
    addedLines += 1;
    for (const hit of scanLine(text)) {
      findings.push({ file, line, text: text.trim().slice(0, 160), ...hit });
    }
  }
  process.exit(report(findings, `${addedLines} added diff line(s) scanned`));
}

main();
