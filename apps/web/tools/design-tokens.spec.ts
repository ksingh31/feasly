/**
 * Issue #493 spec: product tokens, contrast fixes and the global form-font
 * reset (docs/design/portal-ui-kit.md §1, consumer review M5).
 *
 * Every token from the UI-kit spec must be defined in `src/styles.scss` with
 * the spec's value and documented in `docs/design-tokens.md`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..');
const STYLES = readFileSync(join(WEB, 'src/styles.scss'), 'utf8');
const DOCS = readFileSync(join(WEB, '../../docs/design-tokens.md'), 'utf8');

/** Spec values from docs/design/portal-ui-kit.md §1. */
const SPEC_TOKENS: Record<string, string> = {
  '--accent-text': '#8a5f12',
  '--muted': '#6b5f53',
  '--status-neutral-bg': '#efebe4',
  '--status-neutral-fg': '#4a4239',
  '--status-info-bg': '#e6eef9',
  '--status-info-fg': '#1f4f8f',
  '--status-progress-bg': '#f3ead8',
  '--status-progress-fg': '#7a5410',
  '--status-success-bg': '#e3f2ea',
  '--status-success-fg': '#1c6b44',
  '--status-warning-bg': '#fbefd9',
  '--status-warning-fg': '#8a4b06',
  '--status-danger-bg': '#fbe7e5',
  '--status-danger-fg': '#9b2018',
  '--status-paused-bg': '#ede8f5',
  '--status-paused-fg': '#5a3f8c',
  '--space-1': '4px',
  '--space-2': '8px',
  '--space-3': '12px',
  '--space-4': '16px',
  '--space-5': '24px',
  '--space-6': '32px',
  '--space-7': '48px',
  '--space-8': '64px',
  '--radius-sm': '6px',
  '--radius-md': '10px',
  '--radius-lg': '14px',
  '--radius-pill': '999px',
  '--shadow-overlay': '0 12px 40px rgba(28, 25, 20, 0.18)',
  '--scrim': 'rgba(28, 25, 20, 0.32)',
  '--z-sticky': '10',
  '--z-drawer': '40',
  '--z-modal': '50',
  '--z-toast': '60',
  '--type-product-h1': '600 24px/1.25 var(--font-ui)',
  '--type-product-h2': '600 18px/1.3 var(--font-ui)',
  '--type-body': '400 15px/1.55 var(--font-ui)',
  '--type-body-sm': '400 14px/1.5 var(--font-ui)',
  '--type-meta': '400 12px/1.4 var(--font-ui)',
  '--type-label': '600 11px/1.2 var(--font-ui)',
};

function tokenValue(name: string): string | undefined {
  const m = STYLES.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm'));
  return m?.[1].trim();
}

function rule(css: string, selector: string): string {
  const i = css.indexOf(`${selector} {`);
  expect(i, `rule ${selector}`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
}

function scssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? scssFiles(p) : p.endsWith('.scss') ? [p] : [];
  });
}

describe('design tokens (portal UI kit §1)', () => {
  it.each(Object.entries(SPEC_TOKENS))('%s is defined in styles.scss with the spec value', (name, value) => {
    expect(tokenValue(name)).toBe(value);
  });

  it.each(Object.keys(SPEC_TOKENS))('%s is documented in docs/design-tokens.md', (name) => {
    expect(DOCS).toContain(`\`${name}\``);
  });

  it('product type tokens never use the headline font', () => {
    for (const name of Object.keys(SPEC_TOKENS).filter((n) => n.startsWith('--type-'))) {
      expect(tokenValue(name)).not.toContain('--font-headline');
    }
  });
});

describe('global form reset', () => {
  it('form controls inherit font and colour so buttons render in Instrument Sans', () => {
    const body = rule(STYLES, 'button,\ninput,\nselect,\ntextarea');
    expect(body).toMatch(/font:\s*inherit;/);
    expect(body).toMatch(/color:\s*inherit;/);
  });

  it('sets accent-color on :root', () => {
    expect(rule(STYLES, ':root')).toMatch(/accent-color:\s*var\(--accent\);/);
  });
});

describe('consumer contrast fixes (review M5)', () => {
  const files = scssFiles(join(WEB, 'src/app'));

  it('no stylesheet references the undefined --brass token', () => {
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('--brass'));
    expect(offenders).toEqual([]);
  });

  it('brass text uses --accent-text, never --accent (3.6:1 on cream)', () => {
    const offenders = files.filter((f) => /^\s*color:\s*var\(--accent\)\s*;/m.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the City-assessed freshness line has no opacity', () => {
    const css = readFileSync(join(WEB, 'src/app/shared/components/property-card/property-card.component.scss'), 'utf8');
    expect(rule(css, '.pcard-freshness')).not.toMatch(/opacity\s*:/);
  });

  it('error page CTA is the charcoal primary, not white on brass', () => {
    const css = readFileSync(join(WEB, 'src/app/features/error/state-page.scss'), 'utf8');
    const body = rule(css, '.state-page .cta');
    expect(body).toMatch(/background:\s*var\(--canvas\);/);
    expect(body).not.toMatch(/background:\s*var\(--accent\);/);
  });
});
