/**
 * HRD-05 spec: banned-phrase + disclaimer check (check-banned-phrases.mjs).
 *
 * Proves the check bites: banned phrases in user-facing strings are flagged,
 * disclaimer-form negations ("not guarantees") pass, code comments are never
 * scanned, and a missing disclaimer fails the presence check.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPROVED_DISCLAIMER,
  checkBannedPhrases,
  extractStringLiterals,
  scanUnit,
  stripHtmlComments,
} from './check-banned-phrases.mjs';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'banned-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanUnit', () => {
  it('flags a bare guarantee claim', () => {
    const hits = scanUnit('We guarantee the lowest price.', 'x.html');
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain('"guarantee"');
  });

  it('allows the disclaimer form "not guarantees"', () => {
    expect(
      scanUnit('Estimates are ranges, not guarantees.', 'x.html'),
    ).toEqual([]);
  });

  it('flags ± with no exceptions', () => {
    expect(scanUnit('Costs vary ±10%.', 'x.html').length).toBe(1);
  });

  it('flags "accurate within"', () => {
    expect(scanUnit('Accurate within $5,000.', 'x.html').length).toBe(1);
  });

  it('allows "not market value" but flags a bare claim', () => {
    expect(scanUnit('Assessed value (not market value).', 'x.html')).toEqual([]);
    expect(scanUnit('Based on market value.', 'x.html').length).toBe(1);
  });

  it('allows "not an appraisal" but flags a bare claim', () => {
    expect(
      scanUnit('Planning ranges, not appraisals.', 'x.html'),
    ).toEqual([]);
    expect(scanUnit('A certified appraisal.', 'x.html').length).toBe(1);
  });
});

describe('extractStringLiterals', () => {
  it('skips code comments', () => {
    const src = `// the type guarantees no leaks\nconst s = 'hello';`;
    expect(extractStringLiterals(src)).toEqual(['hello']);
  });

  it('extracts template literals', () => {
    const src = 'const s = `We guarantee it`;';
    expect(extractStringLiterals(src)).toEqual(['We guarantee it']);
  });
});

describe('stripHtmlComments', () => {
  it('removes comments before scanning', () => {
    expect(stripHtmlComments('<!-- guarantees --><p>ok</p>')).toBe('<p>ok</p>');
  });
});

describe('checkBannedPhrases disclaimer presence', () => {
  function writeApiSurface(withDisclaimer: boolean) {
    const contractsPath = join(root, 'packages', 'contracts', 'src', 'estimate.ts');
    mkdirSync(join(contractsPath, '..'), { recursive: true });
    writeFileSync(
      contractsPath,
      withDisclaimer
        ? `export const ESTIMATE_DISCLAIMER = '${APPROVED_DISCLAIMER}' as const;\nexport interface EstimateResponse { readonly disclaimer: string; }\n`
        : `export interface EstimateResponse { readonly disclaimer: string; }\n`,
    );
    const servicePath = join(root, 'apps', 'api', 'src', 'services', 'estimate.service.ts');
    mkdirSync(join(servicePath, '..'), { recursive: true });
    writeFileSync(
      servicePath,
      withDisclaimer
        ? `import { ESTIMATE_DISCLAIMER } from '@feasly/contracts';\nconst r = { disclaimer: ESTIMATE_DISCLAIMER };`
        : `const r = {};`,
    );
  }

  it('passes when the API surface carries the verbatim disclaimer', () => {
    writeApiSurface(true);
    const { failures } = checkBannedPhrases(root);
    expect(failures.filter((f) => f.startsWith('api surface'))).toEqual([]);
  });

  it('fails when the disclaimer copy is missing from contracts', () => {
    writeApiSurface(false);
    const { failures } = checkBannedPhrases(root);
    expect(
      failures.some((f) => f.includes('ESTIMATE_DISCLAIMER verbatim copy missing')),
    ).toBe(true);
  });

  it('notes (not fails) the MCP skip when the server is absent', () => {
    writeApiSurface(true);
    const { failures, notes } = checkBannedPhrases(root);
    expect(failures.filter((f) => f.startsWith('mcp surface'))).toEqual([]);
    expect(notes.some((n) => n.includes('MCP server not merged yet'))).toBe(true);
  });
});
