/**
 * check-css-tokens.test.mjs — #676: prove the undefined-token gate bites, and
 * that the real tree is clean.
 *
 * Run: vitest run tools/check-css-tokens.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findBareReferences,
  findDefinitions,
  findRuntimeDefinitions,
  scan,
  stripComments,
} from './check-css-tokens.mjs';

describe('findDefinitions', () => {
  it('collects custom property declarations from any scope', () => {
    const scss = `:root { --text: #111; --space-1: 4px; }
      .card { --local-gap: 8px; gap: var(--local-gap); }`;
    expect([...findDefinitions(scss)].sort()).toEqual(['--local-gap', '--space-1', '--text']);
  });

  it('ignores declarations inside comments', () => {
    expect([...findDefinitions('/* --old: red; */ // --gone: 1px;\n')]).toEqual([]);
  });
});

describe('findRuntimeDefinitions', () => {
  it('collects setProperty() calls and [style.--x] bindings', () => {
    const code = `el.style.setProperty('--embed-accent', c);
      <div [style.--share]="pct"></div>`;
    expect([...findRuntimeDefinitions(code)].sort()).toEqual(['--embed-accent', '--share']);
  });
});

describe('findBareReferences', () => {
  it('returns only var() calls without a fallback, with line numbers', () => {
    const scss = `.a {\n  color: var(--ink);\n  background: var(--bg, white);\n  border-color: var( --edge );\n}`;
    expect(findBareReferences(scss)).toEqual([
      { name: '--ink', line: 2 },
      { name: '--edge', line: 4 },
    ]);
  });

  it('finds references nested in other functions', () => {
    const scss = '.a { background: color-mix(in srgb, var(--accent) 8%, var(--bg)); }';
    expect(findBareReferences(scss).map((r) => r.name)).toEqual(['--accent', '--bg']);
  });

  it('ignores references in comments and keeps line numbers after them', () => {
    const scss = '/* var(--gone)\n spans */\n.a { color: var(--x); }';
    expect(findBareReferences(scss)).toEqual([{ name: '--x', line: 3 }]);
  });
});

describe('stripComments', () => {
  it('keeps url() schemes intact', () => {
    expect(stripComments('a { b: url(https://x.test/y); }')).toContain('https://x.test/y');
  });
});

describe('scan', () => {
  it('flags an undefined bare token and accepts defined / runtime / fallback ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'css-tokens-'));
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'styles.scss'), ':root { --text: #111; }');
    writeFileSync(
      join(dir, 'app', 'a.component.scss'),
      `.a {\n  color: var(--text);\n  background: var(--bg);\n  fill: var(--runtime);\n  stroke: var(--nope, red);\n}`,
    );
    writeFileSync(join(dir, 'app', 'a.component.ts'), "host.style.setProperty('--runtime', v);");
    const problems = scan(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/a\.component\.scss:3 var\(--bg\) — --bg is not defined$/);
  });

  it('the real apps/web/src tree has no undefined bare tokens', () => {
    expect(scan()).toEqual([]);
  });
});
