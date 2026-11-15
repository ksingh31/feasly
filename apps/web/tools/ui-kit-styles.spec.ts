/**
 * Issue #496 (portal UI kit §3 Button + Fields): style contract that unit
 * DOM tests can't see — disabled is 40% opacity (and only disabled dims),
 * visible focus ring, ≥44px mobile tap area, tokens only (no colour
 * literals in shared/ui styles).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const UI = join(here, '../src/app/shared/ui');
const read = (rel: string): string => readFileSync(join(UI, rel), 'utf8');

function scssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) scssFiles(full, out);
    else if (entry.endsWith('.scss')) out.push(full);
  }
  return out;
}

describe('ui-button styles', () => {
  const css = read('button/button.component.scss');

  it('disabled is 40% opacity with not-allowed', () => {
    const block = /:host\(\.ui-button--disabled\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/opacity:\s*0\.4;/);
    expect(block).toMatch(/cursor:\s*not-allowed;/);
  });

  it('no other state dims the button', () => {
    expect(css.match(/opacity:/g)).toHaveLength(1);
  });

  it('shows the spec focus ring on keyboard focus', () => {
    expect(css).toMatch(/:host\(:focus-visible\)\s*\{[^}]*box-shadow:\s*0 0 0 3px var\(--focus-ring\)/);
  });

  it('sizes sm 32px / md 40px with a ≥44px hit area on phones', () => {
    expect(css).toMatch(/:host\s*\{[^}]*height:\s*40px;/);
    expect(css).toMatch(/:host\(\.ui-button--sm\)\s*\{[^}]*height:\s*32px;/);
    expect(css).toMatch(/@media \(max-width: 767px\), \(pointer: coarse\)\s*\{[^@]*max\(100%, 44px\)/);
  });
});

describe('ui fields styles', () => {
  const css = read('fields/_field-control.scss');

  it('focus ring, 40% disabled and a 44px mobile target', () => {
    expect(css).toMatch(/&:focus-visible\s*\{[^}]*box-shadow:\s*0 0 0 3px var\(--focus-ring\)/);
    expect(css).toMatch(/&:disabled\s*\{[^}]*opacity:\s*0\.4;/);
    expect(css).toMatch(/min-height:\s*44px;/);
  });

  it('select draws exactly one chevron (native arrow removed)', () => {
    const select = read('fields/select.component.scss');
    expect(select).toMatch(/appearance:\s*none;/);
    expect(select.match(/background-image:/g)).toHaveLength(1);
  });
});

describe('shared/ui uses tokens only', () => {
  it('has no hex or rgb() colour literals', () => {
    for (const file of scssFiles(UI)) {
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(src, file).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });
});
