/**
 * #612 guard: keep lazy pages out of the initial bundle.
 *
 * Angular emits component classes with static side-effect metadata, so
 * esbuild cannot tree-shake a component re-exported through a feature
 * barrel (`features/<x>/index.ts`). When the root shell files import a
 * state, guard, or service THROUGH such a barrel, every component the
 * barrel re-exports lands in `main` — even pages that already have a lazy
 * `loadComponent` route. That leak (compare picker + results, embed shell,
 * report page) pushed community pages past the 221 kB Lighthouse script
 * budget.
 *
 * Rules checked here (static source scan — the real measurement is the
 * Lighthouse `resource-summary:script:size` gate):
 *   1. The root shell files (app.ts, app.config.ts, app.routes.ts) never
 *      import a feature barrel that re-exports a component.
 *   2. The funnel pages reached only after the landing step are lazy in
 *      app.routes.ts (`loadComponent`), never eager `component:` routes.
 *   3. (#980) The eagerly routed pages never import the shared components
 *      barrel — it re-exports every shared component, none tree-shake.
 *   4. (#980) The /how-it-works and /faq pages are lazy routes too.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');
const SHELL_FILES = ['app.ts', 'app.config.ts', 'app.routes.ts'];

/** Relative `./features/<name>` specifiers that resolve to a barrel index. */
function barrelImports(source: string): string[] {
  const specs = [...source.matchAll(/from\s+'(\.\/features\/[^']+)'/g)].map((m) => m[1]);
  return specs.filter((s) => existsSync(join(APP, s, 'index.ts')));
}

function barrelExportsComponent(spec: string): boolean {
  const index = readFileSync(join(APP, spec, 'index.ts'), 'utf8');
  return /Component\b/.test(index) || /export \* from '[^']*\.component'/.test(index);
}

describe('initial bundle imports (#612)', () => {
  for (const file of SHELL_FILES) {
    it(`${file} imports no component-exporting feature barrel`, () => {
      const source = readFileSync(join(APP, file), 'utf8');
      const offenders = barrelImports(source).filter(barrelExportsComponent);
      expect(offenders).toEqual([]);
    });
  }

  it('detects a component-exporting barrel import (the rule bites)', () => {
    const offenders = barrelImports("import { ComparisonState } from './features/compare';").filter(
      barrelExportsComponent,
    );
    expect(offenders).toEqual(['./features/compare']);
  });

  const LAZY_PAGES = [
    'ScopePageComponent',
    'RenoScopePageComponent',
    'GatePageComponent',
    'AnalyzingPageComponent',
    'PreviewPageComponent',
    'ReportPageComponent',
    // #980: marketing pages are lazy so community pages don't carry them.
    'HowItWorksPageComponent',
    'FaqPageComponent',
  ];

  it('funnel pages after the landing step are lazy-loaded routes', () => {
    const routes = readFileSync(join(APP, 'app.routes.ts'), 'utf8');
    for (const page of LAZY_PAGES) {
      expect(routes, `${page} must not be an eager route`).not.toContain(`component: ${page}`);
      expect(routes, `${page} must be loaded via loadComponent`).toContain(`m.${page}`);
    }
  });

  // #980: eager route components (app.routes.ts `component:` routes).
  const EAGER_PAGES = [
    'features/landing/landing-page.component.ts',
    'features/error/error-page.component.ts',
    'features/error/offline-page.component.ts',
    'features/not-found/not-found-page.component.ts',
  ];

  for (const file of EAGER_PAGES) {
    it(`${file} imports shared components by subpath, not the barrel`, () => {
      const source = readFileSync(join(APP, file), 'utf8');
      expect(source).not.toMatch(/from '(\.\.\/)+shared\/components'/);
      expect(source).not.toMatch(/from '@app\/shared(\/components)?'/);
    });
  }
});
