/**
 * HRD-05 spec: CASL diff test (check-casl-copy.mjs).
 *
 * Proves the check bites: it reports drift when the app's caslLabel differs
 * from the approved wording, and passes when they byte-match.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkCaslCopy,
  extractAppWording,
  extractApprovedWording,
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
  writeFileSync(defaultsPath, `export const x = {\n  caslLabel:\n    '${appWording}',\n};\n`);

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

  it('extracts the exact caslLabel literal', () => {
    writeTree(WORDING_A, WORDING_A);
    expect(extractAppWording(root)).toBe(WORDING_A);
  });

  it('extracts the fenced text block from the CASL section', () => {
    writeTree(WORDING_A, WORDING_A);
    expect(extractApprovedWording(root)).toBe(WORDING_A);
  });
});
