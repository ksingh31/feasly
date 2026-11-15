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
  checkSingleUnlock,
  jsonStrings,
  templateText,
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

describe('single "Unlock" in user-facing copy (#506)', () => {
  const defaultsRel = ['apps', 'web', 'src', 'app', 'core', 'config', 'app-config.defaults.ts'];
  const jsonRel = ['apps', 'web', 'public', 'assets', 'config', 'app-config.json'];
  const templateRel = ['apps', 'web', 'src', 'app', 'features', 'x', 'x.component.html'];

  function write(rel: string[], content: string) {
    const p = join(root, ...rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }

  function defaults(extra = '', cta = "'Unlock my free report →'") {
    return [
      'export const DEFAULTS = {',
      '  copy: {',
      '    compare: {',
      "      unlockCta: 'Show my free comparison →',",
      '    },',
      '    report: {',
      "      // the one unlock CTA (comments are not copy)",
      `      unlockCta: ${cta},`,
      `      lockedNote: 'Revealed when you get your free report.',${extra}`,
      '    },',
      '  },',
      '};',
      '',
    ].join('\n');
  }

  it('passes the real repository (exactly one "Unlock", on the preview CTA)', () => {
    expect(checkSingleUnlock()).toEqual([]);
  });

  it('passes a single Unlock on copy.report.unlockCta', () => {
    write(defaultsRel, defaults());
    write(jsonRel, JSON.stringify({ copy: { report: { unlockCta: 'Unlock my free report →' } } }));
    write(templateRel, '<a class="cta unlock" (click)="unlock()">{{ copy.unlockCta }}</a>\n@if (unlocked() && f(); as x) { <p>Hi</p> }');
    expect(checkSingleUnlock(root)).toEqual([]);
  });

  it('fails a second Unlock string in the defaults (any case or form)', () => {
    write(defaultsRel, defaults("\n      tierLockedNote: 'The breakdown unlocks with your report.',"));
    const failures = checkSingleUnlock(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('found 2');
  });

  it('fails when the one Unlock is not the preview CTA', () => {
    write(
      defaultsRel,
      defaults("\n      submitLabel: 'Unlock my report →',", "'Get my free report →'"),
    );
    expect(checkSingleUnlock(root).some((f) => f.includes('must be the preview CTA'))).toBe(true);
  });

  it('fails visible template text with Unlock but ignores bindings and attributes', () => {
    write(defaultsRel, defaults());
    write(templateRel, '<button class="unlock" (click)="unlock()">Unlock now</button>');
    const failures = checkSingleUnlock(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('Unlock now');
  });

  it('fails an Unlock in the runtime JSON outside copy.report.unlockCta', () => {
    write(defaultsRel, defaults());
    write(jsonRel, JSON.stringify({ copy: { gate: { submitLabel: 'Unlock my free report →' } } }));
    const failures = checkSingleUnlock(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('copy.gate.submitLabel');
  });

  it('is part of the full banned-phrase check', () => {
    write(defaultsRel, defaults("\n      x: 'unlock it',"));
    expect(checkBannedPhrases(root).failures.some((f) => f.includes('"Unlock"'))).toBe(true);
  });

  it('templateText keeps only visible text', () => {
    expect(templateText('<!-- unlock --><a class="unlock">{{ copy.unlockCta }}</a>').trim()).toBe('');
  });

  it('jsonStrings walks nested objects and arrays with dotted paths', () => {
    expect(jsonStrings({ a: { b: ['x', { c: 'y' }] } })).toEqual([
      { path: 'a.b[0]', text: 'x' },
      { path: 'a.b[1].c', text: 'y' },
    ]);
  });
});
