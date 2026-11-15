/**
 * Issue #675: the before → after box in every money modal rendered
 * near-black with --muted text (unreadable, fails AA). Root cause: the
 * boxes used `--canvas-2`, which is the DARK surface token, not a light
 * inset. Tokens live on `:root`, so they already reach the CDK overlay
 * container (it renders under `body`, outside any shell wrapper) — this
 * guard pins both halves of that:
 *   1. design tokens are declared on `:root`, never only on a shell/theme
 *      wrapper the overlay sits outside, and no dark colour scheme leaks in;
 *   2. light insets use `--surface-sunken`, which resolves to a light
 *      colour with AA contrast for `--text` and `--muted`;
 *   3. dark surface tokens are only used as a background where the same
 *      rule sets on-dark text (or for a hover on a dark control).
 *
 * jsdom doesn't load the global stylesheet, so computed colours can't be
 * asserted in the component specs; this resolves the tokens statically.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..');
const APP = join(WEB, 'src/app');
const STYLES = readFileSync(join(WEB, 'src/styles.scss'), 'utf8');

function scssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? scssFiles(p) : p.endsWith('.scss') ? [p] : [];
  });
}

/** Resolve a :root token to a #rrggbb hex, following var() aliases. */
function resolveHex(name: string, depth = 0): string {
  const m = STYLES.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm'));
  expect(m, `${name} is defined in styles.scss`).not.toBeNull();
  const value = m![1].trim();
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  if (alias && depth < 5) return resolveHex(alias[1], depth + 1);
  expect(value, `${name} resolves to a hex colour`).toMatch(/^#[0-9a-f]{6}$/i);
  return value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every `selector { body }` block (innermost, no nesting) in a stylesheet. */
function rules(css: string): { selector: string; body: string }[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{};]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim(),
    body,
  }));
}

describe('tokens reach the CDK overlay container', () => {
  it('surface and text tokens are declared on :root (inherited by body > .cdk-overlay-container)', () => {
    const root = /:root\s*\{([\s\S]*?)\n\}/.exec(STYLES)?.[1] ?? '';
    for (const token of ['--surface-sunken', '--cream-2', '--card', '--text', '--muted', '--border']) {
      expect(root, token).toMatch(new RegExp(`^\\s*${token}:`, 'm'));
    }
  });

  it('no stylesheet redefines a surface/text token on a narrower scope', () => {
    const offenders = scssFiles(APP).filter((f) =>
      /^\s*--(surface-sunken|cream-2|card|text|muted|border|canvas|canvas-2):/m.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => relative(WEB, f))).toEqual([]);
  });

  it('no dark colour scheme leaks into the light portals', () => {
    for (const f of [join(WEB, 'src/styles.scss'), ...scssFiles(APP)]) {
      expect(readFileSync(f, 'utf8'), relative(WEB, f)).not.toMatch(/prefers-color-scheme:\s*dark|color-scheme:\s*dark/);
    }
  });
});

describe('--surface-sunken (light inset)', () => {
  const bg = resolveHex('--surface-sunken');

  it('is a light surface', () => {
    expect(luminance(bg)).toBeGreaterThan(0.7);
  });

  it.each(['--text', '--muted'])('%s on it clears WCAG AA 4.5:1', (token) => {
    expect(contrast(resolveHex(token), bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('modal before → after boxes', () => {
  const COMPARE_BOXES: [string, string][] = [
    ['features/admin/admin-invoice-modal.scss', '.invoice-modal__compare'],
    ['features/admin/admin-create-invoice.component.scss', '.create-invoice__compare'],
    ['features/builder/builder-invoice-method-modal.component.scss', '.method-modal__side'],
  ];

  it.each(COMPARE_BOXES)('%s %s sits on --surface-sunken', (file, selector) => {
    const rule = rules(readFileSync(join(APP, file), 'utf8')).find((r) => r.selector === selector);
    expect(rule, selector).toBeDefined();
    expect(rule!.body).toMatch(/background:\s*var\(--surface-sunken\);/);
  });
});

describe('dark surface tokens in the portals and their overlays', () => {
  /** Light portals whose modals/drawers render in the overlay container. */
  const PORTAL_DIRS = ['features/admin', 'features/builder', 'shared/ui'].map((d) => join(APP, d));

  it('are a background only where the rule sets on-dark text, or on a hover of a dark control', () => {
    const offenders: string[] = [];
    for (const f of PORTAL_DIRS.flatMap(scssFiles)) {
      for (const { selector, body } of rules(readFileSync(f, 'utf8'))) {
        if (!/background(-color)?:\s*var\(--canvas(-2)?\)/.test(body)) continue;
        const onDark = /(^|[^-])color:\s*var\(--(on-dark|cta-fg|on-dark-muted)\)/.test(body);
        const hover = /:hover/.test(selector);
        if (!onDark && !hover) offenders.push(`${relative(WEB, f)} ${selector}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
