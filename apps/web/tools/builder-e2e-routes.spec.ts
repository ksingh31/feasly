/**
 * #536 guard: the Playwright no-overflow e2e covers EVERY builder route.
 *
 * Reads the builder section of `app.routes.ts` (from `builder/login` up to
 * the next non-builder route) and checks that each router path is either
 * visited by `e2e/builder-no-overflow.e2e.ts` (BUILDER_E2E_ROUTES) or is a
 * pure redirect (BUILDER_REDIRECT_PATHS). Adding a builder page without an
 * e2e entry fails here — this runs in CI with the rest of `test:tools`,
 * while the browser suite itself runs via `npm run e2e`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILDER_E2E_ROUTES, BUILDER_REDIRECT_PATHS } from '../e2e/builder-routes';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_FILE = join(WEB, 'src', 'app', 'app.routes.ts');

interface ParsedRoute {
  readonly path: string;
  readonly redirect: boolean;
}

/** Router paths in the builder block, normalised to full `builder/...` paths. */
function builderRoutes(source: string): ParsedRoute[] {
  const start = source.indexOf("path: 'builder/login'");
  expect(start, 'builder/login route in app.routes.ts').toBeGreaterThan(-1);
  const rest = source.slice(start);
  // The builder block ends at the first top-level route (4-space indent,
  // children sit deeper) whose path isn't a builder path.
  const end = rest.search(/\n {4}path: '(?!builder)/);
  const block = end === -1 ? rest : rest.slice(0, end);
  const routes: ParsedRoute[] = [];
  const re = /path: '([^']*)',(\s*redirectTo)?/g;
  for (let m = re.exec(block); m; m = re.exec(block)) {
    const raw = m[1]!;
    const path = raw.startsWith('builder') ? raw : raw === '' ? 'builder' : `builder/${raw}`;
    routes.push({ path, redirect: Boolean(m[2]) });
  }
  return routes;
}

describe('#536 builder e2e covers every builder route', () => {
  const routes = builderRoutes(readFileSync(ROUTES_FILE, 'utf8'));
  const visited = new Set(BUILDER_E2E_ROUTES.map((r) => r.path));
  const redirects = new Set(BUILDER_REDIRECT_PATHS);

  it('finds the builder routes', () => {
    expect(routes.map((r) => r.path)).toEqual(
      expect.arrayContaining(['builder/login', 'builder', 'builder/money', 'builder/team']),
    );
  });

  it('visits every non-redirect builder route', () => {
    const missing = routes.filter((r) => !r.redirect && !visited.has(r.path)).map((r) => r.path);
    expect(missing).toEqual([]);
  });

  it('lists exactly the redirect-only builder routes as skipped', () => {
    const actual = routes.filter((r) => r.redirect).map((r) => r.path).sort();
    expect([...redirects].sort()).toEqual(actual);
  });

  it('has no stale e2e entries for removed routes', () => {
    const known = new Set(routes.map((r) => r.path));
    const stale = BUILDER_E2E_ROUTES.filter((r) => !known.has(r.path)).map((r) => r.path);
    expect(stale).toEqual([]);
  });

  it('uses unique screenshot names', () => {
    const names = BUILDER_E2E_ROUTES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
