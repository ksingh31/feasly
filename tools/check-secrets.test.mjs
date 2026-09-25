/**
 * check-secrets.test.mjs — HRD-07 AC1: prove the secrets gate bites.
 *
 * Every fixture value below is deliberately fake (fake/test/dummy material).
 * This file is allowlisted in tools/.secrets-allowlist precisely so the
 * fixtures don't trip the gate on this PR's own diff.
 *
 * Run: node --test tools/check-secrets.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCANNER = join(HERE, 'check-secrets.mjs');

function diffFor(file, addedLines) {
  const body = addedLines.map((l) => '+' + l).join('\n');
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${addedLines.length} @@`,
    body,
    '',
  ].join('\n');
}

function runScan({ diff = null, bundle = null, allowlist = null } = {}) {
  const args = [];
  if (diff !== null) args.push('--stdin');
  if (bundle !== null) args.push('--bundle', bundle);
  if (allowlist !== null) args.push('--allowlist', allowlist);
  try {
    const stdout = execFileSync('node', [SCANNER, ...args], {
      input: diff ?? undefined,
      encoding: 'utf8',
      cwd: join(HERE, '..'),
    });
    return { exit: 0, stdout };
  } catch (e) {
    return { exit: e.status ?? 2, stdout: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

const fails = (r) => assert.equal(r.exit, 1, `expected violation, got exit ${r.exit}:\n${r.stdout}`);
const clean = (r) => assert.equal(r.exit, 0, `expected clean, got exit ${r.exit}:\n${r.stdout}`);

describe('diff scan — violations fail', () => {
  it('flags sk_live_ even when fake-looking (HRD-07 AC1)', () => {
    fails(runScan({ diff: diffFor('src/billing/stripe.service.ts', ["const key = 'sk_live_fake123456';"]) }));
  });

  it('flags real-looking sk_test_ but passes sk_test_fake', () => {
    fails(runScan({ diff: diffFor('src/a.ts', ['sk_test_51HxYzAbC9dEfGh']) }));
    clean(runScan({ diff: diffFor('src/a.ts', ["stripeSecretKey: 'sk_test_fake',"]) }));
    clean(runScan({ diff: diffFor('src/a.ts', ['STRIPE_SECRET_KEY: sk_test_123']) }));
  });

  it('flags real-looking whsec_ but passes whsec_fake', () => {
    fails(runScan({ diff: diffFor('src/a.ts', ['whsec_9f8e7d6c5b4a3948']) }));
    clean(runScan({ diff: diffFor('src/a.ts', ["stripeWebhookSecret: 'whsec_fake',"]) }));
  });

  it('flags PEM private key blocks', () => {
    fails(runScan({ diff: diffFor('certs/key.pem', ['-----BEGIN PRIVATE KEY-----', 'MIIFak3DummY', '-----END PRIVATE KEY-----']) }));
  });

  it('flags Slack tokens', () => {
    fails(runScan({ diff: diffFor('src/a.ts', ['token = "xoxb-1234567890-faketesttoken"']) }));
  });

  it('flags AZURE_CLIENT_SECRET assignments, passes placeholders', () => {
    fails(runScan({ diff: diffFor('.env', ['AZURE_CLIENT_SECRET=AbC123xYzRealLookingSecret']) }));
    clean(runScan({ diff: diffFor('.env', ['AZURE_CLIENT_SECRET=<your-client-secret>']) }));
  });

  it('flags Postmark server tokens, passes placeholders', () => {
    fails(runScan({ diff: diffFor('.env', ['EMAIL_POSTMARK_SERVER_TOKEN=9f8e7d6c-5b4a-3948-a1b2-c3d4e5f60718']) }));
    clean(runScan({ diff: diffFor('.env', ['EMAIL_POSTMARK_SERVER_TOKEN=<postmark-token>']) }));
  });

  it('flags ACS access keys, passes placeholders', () => {
    fails(runScan({ diff: diffFor('.env', ['EMAIL_ACS_CONNECTION_STRING=endpoint=https://x.communication.azure.com/;accesskey=R3alAcc3ssK3yMaterial==']) }));
    clean(runScan({ diff: diffFor('.env', ['EMAIL_ACS_CONNECTION_STRING=endpoint=https://x.communication.azure.com/;accesskey=<redacted>']) }));
  });

  it('flags real passwords in DATABASE_URL, passes changeme', () => {
    fails(runScan({ diff: diffFor('.env', ['DATABASE_URL=postgres://feasly:s3cr3tP4ssw0rd@pg:5432/feasly']) }));
    clean(runScan({ diff: diffFor('.env', ['DATABASE_URL=postgres://feasly:changeme@pg:5432/feasly']) }));
  });
});

describe('diff scan — no false positives', () => {
  it('ignores context (non-added) lines', () => {
    const d = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      " const key = 'sk_live_fake123456';",
      "+const ok = true;",
      '',
    ].join('\n');
    clean(runScan({ diff: d }));
  });

  it('ignores zod schema declarations', () => {
    clean(runScan({ diff: diffFor('src/config.ts', ['STRIPE_SECRET_KEY: z.string().min(1).optional(),']) }));
  });

  it('ignores prose mentions of key prefixes', () => {
    clean(runScan({ diff: diffFor('src/config.ts', ['// production REQUIRES an sk_live_ key — enforced at startup']) }));
    clean(runScan({ diff: diffFor('src/config.ts', ["startsWith('sk_live_')"]) }));
  });

  it('respects the allowlist for this fixture file', () => {
    // tools/check-secrets.test.mjs is allowlisted with a reason comment.
    clean(runScan({ diff: diffFor('tools/check-secrets.test.mjs', ["const key = 'sk_live_fake123456';"]) }));
  });
});

describe('allowlist hygiene', () => {
  it('fails closed when an entry has no reason comment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'allow-'));
    const p = join(dir, 'allowlist');
    writeFileSync(p, 'some/file.ts\n');
    const r = runScan({ diff: diffFor('src/a.ts', ['const ok = true;']), allowlist: p });
    assert.equal(r.exit, 2, `expected config error, got exit ${r.exit}:\n${r.stdout}`);
    assert.match(r.stdout, /no "# reason" comment/);
  });
});

describe('bundle scan', () => {
  it('flags secret material in built output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeFileSync(join(dir, 'main.js'), 'console.log("ok");\nconst k="sk_live_fake123456";\n');
    const r = runScan({ bundle: dir });
    assert.equal(r.exit, 1, `expected violation, got exit ${r.exit}:\n${r.stdout}`);
    assert.match(r.stdout, /stripe-live-key/);
  });

  it('passes a clean bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'main.js'), 'console.log("hello world");\n');
    writeFileSync(join(dir, 'assets', 'logo.svg'), '<svg></svg>\n');
    clean(runScan({ bundle: dir }));
  });
});
