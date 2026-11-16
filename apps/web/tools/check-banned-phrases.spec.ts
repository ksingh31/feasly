/**
 * HRD-05 spec: banned-phrase + disclaimer check (check-banned-phrases.mjs).
 *
 * Proves the check bites: banned phrases in user-facing strings are flagged,
 * disclaimer-form negations ("not guarantees") pass, code comments are never
 * scanned, and a missing disclaimer fails the presence check.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPROVED_DISCLAIMER,
  checkBannedPhrases,
  checkMcpToolDefinitions,
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

describe('MCP tool-definition disclaimer check (#765)', () => {
  function writeTools(defs: string, withImport = true) {
    const p = join(root, 'packages', 'mcp', 'src', 'tools.ts');
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(
      p,
      [
        withImport ? "import { ESTIMATE_DISCLAIMER } from '@feasly/contracts';" : '',
        'export const DETERMINISTIC_DISCLAIMER = ` ${ESTIMATE_DISCLAIMER}` + " deterministically";',
        'export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [',
        defs,
        '];',
        '',
      ].join('\n'),
    );
  }
  const tool = (name: string, withDisclaimer: boolean) =>
    `  {\n    name: '${name}',\n    description:\n      'Does ${name}.'${withDisclaimer ? ' +\n      DETERMINISTIC_DISCLAIMER' : ''},\n    inputShape: {},\n  },`;

  it('passes when every tool appends the disclaimer', () => {
    writeTools([tool('a', true), tool('b', true)].join('\n'));
    expect(checkMcpToolDefinitions(root)).toEqual([]);
  });

  it('fails naming the one tool that drops the disclaimer', () => {
    writeTools([tool('a', true), tool('b', false)].join('\n'));
    const failures = checkMcpToolDefinitions(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('tool b');
  });

  it('fails when the disclaimer is not sourced from @feasly/contracts', () => {
    writeTools(tool('a', true), false);
    expect(
      checkMcpToolDefinitions(root).some((f) => f.includes('does not import ESTIMATE_DISCLAIMER')),
    ).toBe(true);
  });

  it('is wired into checkBannedPhrases', () => {
    writeTools(tool('a', false));
    const { failures } = checkBannedPhrases(root);
    expect(failures.some((f) => f.includes('tool a'))).toBe(true);
  });

  it('passes on the real repo tools.ts', () => {
    expect(checkMcpToolDefinitions(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))).toEqual([]);
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

describe('neutral-matching claims contradicting the partner disclosure (#878)', () => {
  const OLD_COPY = [
    'Feasly is an independent estimator — we don’t build homes, rank builders, or hand-pick who contacts you.',
    'Our system matches on project fit — no favourites, no paid placement.',
    'we do not rank or recommend specific builders.',
  ];

  it.each([
    ['paid placement', 'No paid placement.'],
    ['no favourites', 'No favourites here.'],
    ['no favourites', 'No favorites here.'],
    ['project fit', 'We match on project fit.'],
    ['hand-pick', 'We never hand-pick builders.'],
    ['hand-pick', 'We never handpick builders.'],
    ['rank builders', 'We don’t rank builders.'],
    ['rank or recommend', 'We do not rank or recommend builders.'],
  ])('flags "%s" even in negated form: %s', (name, text) => {
    const hits = scanUnit(text, 'x.ts');
    expect(hits.some((h) => h.includes(`"${name}"`))).toBe(true);
  });

  it('flags every sentence of the old explainer/FAQ copy', () => {
    for (const s of OLD_COPY) expect(scanUnit(s, 'x.ts').length).toBeGreaterThan(0);
  });

  it('allows the approved partner-model wording', () => {
    const approved =
      'Feasly is an independent estimator. We don’t build homes. If you ask to be contacted, leads from Feasly’s own site go to our builder partner(s), listed on How it works. A partner pays Feasly a referral commission only if you sign a contract with them. It never changes your estimate, and you’re never obliged to hire anyone.';
    expect(scanUnit(approved, 'x.ts')).toEqual([]);
  });

  it('scans the runtime config JSON, not just the compiled defaults', () => {
    const p = join(root, 'apps', 'web', 'public', 'assets', 'config', 'app-config.json');
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify({ copy: { faq: { items: [{ a: 'No paid placement.' }] } } }));
    const { failures } = checkBannedPhrases(root);
    expect(failures.some((f) => f.includes('copy.faq.items[0].a') && f.includes('"paid placement"'))).toBe(true);
  });

  it('passes the real repository', () => {
    const { failures } = checkBannedPhrases();
    expect(failures.filter((f) => /paid placement|favourites|project fit|hand-pick|rank/.test(f))).toEqual([]);
  });
});
