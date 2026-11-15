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
    expect(body).toMatch(/background:\s*var\(--cta-bg\);/);
    expect(body).not.toMatch(/background:\s*var\(--accent\);/);
  });
});

/**
 * Issue #511 (consumer review S1, S2, S10): one primary CTA style, one wizard
 * column width, no off-token hex literals in consumer stylesheets.
 */
const APP = join(WEB, 'src/app');
const read = (rel: string): string => readFileSync(join(APP, rel), 'utf8');

/** Consumer-facing stylesheets (portals are covered by the portal UI kit). */
const CONSUMER_DIRS = ['wizard', 'report', 'embed', 'error', 'communities', 'landing', 'compare', 'consent', 'sample-report'];
const consumerFiles = CONSUMER_DIRS.flatMap((d) => scssFiles(join(APP, 'features', d)));

describe('primary CTA token (review S1)', () => {
  const CTA_TOKENS: Record<string, string> = {
    '--cta-bg': 'var(--canvas)',
    '--cta-fg': 'var(--on-dark)',
    '--cta-bg-hover': 'var(--canvas-2)',
    '--cta-on-dark-bg': 'var(--accent-dark)',
    '--cta-on-dark-fg': 'var(--canvas)',
    '--cta-on-dark-bg-hover': '#d6a244',
  };

  it.each(Object.entries(CTA_TOKENS))('%s is defined and documented', (name, value) => {
    expect(tokenValue(name)).toBe(value);
    expect(DOCS).toContain(`\`${name}\``);
  });

  it.each([
    ['features/wizard/wizard-shell.scss', '.cta', '--cta-bg'],
    ['features/error/state-page.scss', '.state-page .cta', '--cta-bg'],
    ['features/compare/compare-picker-page.component.scss', '.cta', '--cta-bg'],
    ['features/compare/compare-results/compare-results.component.scss', '.compare-results__unlock', '--cta-bg'],
    ['features/communities/community-page.component.scss', '.community .cta-card .cta', '--cta-on-dark-bg'],
    ['features/communities/community-profile-page.component.scss', '.community-profile .cta-card .cta', '--cta-on-dark-bg'],
    ['features/landing/landing-page.component.scss', '.sample-report-link a', '--cta-on-dark-bg'],
  ])('%s %s uses the %s token', (file, selector, token) => {
    expect(rule(read(file), selector)).toContain(`background: var(${token});`);
  });

  it('embed CTA falls back to the primary token when no builder accent is set', () => {
    expect(rule(read('features/embed/embed-shell.component.scss'), '.embed-cta')).toContain(
      'background: var(--embed-accent, var(--cta-bg));',
    );
  });

  it('reno scope uses the shared wizard CTA, not a local brass one', () => {
    expect(read('features/wizard/reno-scope-page.component.scss')).not.toMatch(/^\.cta\s*\{/m);
  });

  it('no consumer CTA puts white text on brass', () => {
    const offenders = consumerFiles.filter((f) =>
      [...readFileSync(f, 'utf8').matchAll(/([^{}]*cta[^{}]*)\{([^{}]*)\}/g)].some(
        ([, , body]) => /background:\s*var\(--accent(-deep)?\)/.test(body) && /color:\s*#fff\b/.test(body),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe('wizard column width (review S2)', () => {
  it('--wizard-width is defined and documented', () => {
    expect(tokenValue('--wizard-width')).toBe('720px');
    expect(DOCS).toContain('`--wizard-width`');
  });

  it('the shared shell sizes every step from the token and never shrinks to content', () => {
    const body = rule(read('features/wizard/wizard-shell.scss'), '.wrap');
    expect(body).toContain('max-width: var(--wizard-width);');
    expect(body).toMatch(/\bwidth:\s*100%;/);
  });

  it('no wizard step overrides the column width', () => {
    const offenders = scssFiles(join(APP, 'features/wizard'))
      .filter((f) => !f.endsWith('wizard-shell.scss'))
      .filter((f) => /^\s*max-width:\s*\d/m.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('every wizard step and the report use the shared shell', () => {
    const dirs = [join(APP, 'features/wizard'), join(APP, 'features/report')];
    const pages = dirs.flatMap((d) =>
      readdirSync(d)
        .filter((f) => f.endsWith('-page.component.ts'))
        .map((f) => join(d, f)),
    );
    expect(pages.length).toBeGreaterThan(5);
    for (const p of pages) expect(readFileSync(p, 'utf8'), p).toContain('wizard-shell.scss');
  });
});

describe('off-token hex literals (review S10)', () => {
  it.each(['#e8e0d2', '#fffdf8', '#5e470c', '#d9a441', '#c08a24', '#f8f6f1', '#b4552d', '#6f7a3a', '#e8e2d5'])(
    'consumer stylesheets never use %s',
    (hex) => {
      const offenders = consumerFiles.filter((f) => readFileSync(f, 'utf8').toLowerCase().includes(hex));
      expect(offenders).toEqual([]);
    },
  );

  it('consumer stylesheets have no hex fallbacks on var() (they hide undefined tokens)', () => {
    const offenders = consumerFiles.filter((f) => /var\(--[\w-]+,\s*#/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
