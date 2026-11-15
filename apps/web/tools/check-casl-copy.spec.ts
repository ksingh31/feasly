/**
 * HRD-05 spec: CASL diff test (check-casl-copy.mjs).
 *
 * Proves the check bites: it reports drift when the app's consentLabel differs
 * from the approved wording, and passes when they byte-match.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkCaslCopy,
  checkWaitlistCaslCopy,
  extractAppWording,
  extractApprovedWording,
  extractWaitlistAppWording,
  extractWaitlistApprovedWording,
} from './check-casl-copy.mjs';

const WORDING_A = 'It’s okay to email me updates. I can unsubscribe anytime.';
const WORDING_B = 'It’s okay to email me updates! I can unsubscribe anytime.';

let root: string;

function writeTree(appWording: string, approvedWording: string) {
  const defaultsPath = join(
    root,
    'apps',
    'web',
    'src',
    'app',
    'core',
    'config',
    'app-config.defaults.ts',
  );
  mkdirSync(join(defaultsPath, '..'), { recursive: true });
  writeFileSync(defaultsPath, `export const x = {\n  consentLabel:\n    '${appWording}',\n};\n`);

  const mdPath = join(root, 'docs', 'legal', 'approved-copy.md');
  mkdirSync(join(mdPath, '..'), { recursive: true });
  writeFileSync(
    mdPath,
    `# Approved\n\n### CASL consent wording\n\n\`\`\`text\n${approvedWording}\n\`\`\`\n`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'casl-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('checkCaslCopy', () => {
  it('passes when the wordings byte-match', () => {
    writeTree(WORDING_A, WORDING_A);
    expect(checkCaslCopy(root)).toBeNull();
  });

  it('fails on a one-character drift', () => {
    writeTree(WORDING_B, WORDING_A);
    const drift = checkCaslCopy(root);
    expect(drift).not.toBeNull();
    expect(drift!.appWording).toBe(WORDING_B);
    expect(drift!.approvedWording).toBe(WORDING_A);
  });

  it('extracts the exact consentLabel literal', () => {
    writeTree(WORDING_A, WORDING_A);
    expect(extractAppWording(root)).toBe(WORDING_A);
  });

  it('extracts the fenced text block from the CASL section', () => {
    writeTree(WORDING_A, WORDING_A);
    expect(extractApprovedWording(root)).toBe(WORDING_A);
  });
});

/** #520: gate + waitlist wordings side by side, as in the real files. */
function writeBothTrees(gate: string, waitlistApp: string, waitlistApproved: string) {
  const defaultsPath = join(root, 'apps', 'web', 'src', 'app', 'core', 'config', 'app-config.defaults.ts');
  mkdirSync(join(defaultsPath, '..'), { recursive: true });
  writeFileSync(
    defaultsPath,
    `export const x = {\n  gate: {\n    consentLabel:\n      '${gate}',\n  },\n  waitlist: {\n    consentLabel:\n      '${waitlistApp}',\n  },\n};\n`,
  );
  const mdPath = join(root, 'docs', 'legal', 'approved-copy.md');
  mkdirSync(join(mdPath, '..'), { recursive: true });
  writeFileSync(
    mdPath,
    `# Approved\n\n### CASL consent wording\n\n\`\`\`text\n${gate}\n\`\`\`\n\n` +
      `### CASL waitlist consent wording\n\n\`\`\`text\n${waitlistApproved}\n\`\`\`\n`,
  );
}

describe('checkWaitlistCaslCopy (#520)', () => {
  const GATE = 'Gate wording. I can opt out anytime.';

  it('passes when the waitlist wordings byte-match, without disturbing the gate check', () => {
    writeBothTrees(GATE, WORDING_A, WORDING_A);
    expect(checkWaitlistCaslCopy(root)).toBeNull();
    expect(checkCaslCopy(root)).toBeNull();
    expect(extractWaitlistAppWording(root)).toBe(WORDING_A);
    expect(extractWaitlistApprovedWording(root)).toBe(WORDING_A);
    expect(extractAppWording(root)).toBe(GATE);
    expect(extractApprovedWording(root)).toBe(GATE);
  });

  it('fails on a one-character drift in the waitlist wording', () => {
    writeBothTrees(GATE, WORDING_B, WORDING_A);
    expect(checkWaitlistCaslCopy(root)).toEqual({ appWording: WORDING_B, approvedWording: WORDING_A });
    expect(checkCaslCopy(root)).toBeNull();
  });
});
