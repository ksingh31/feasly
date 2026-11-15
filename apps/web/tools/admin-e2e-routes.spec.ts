/**
 * #548 guard: the Playwright admin visual-QA e2e covers EVERY admin route.
 *
 * Reads the admin section of `app.routes.ts` (from `admin/login` up to the
 * next non-admin top-level route) and checks that each router path is
 * either visited by `e2e/admin-no-overflow.e2e.ts` (ADMIN_E2E_ROUTES) or is
 * a pure redirect (ADMIN_REDIRECT_PATHS). Adding an admin page without an
 * e2e entry fails here — this runs in CI with the rest of `test:tools`,
 * while the browser suite itself runs via `npm run e2e`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_E2E_OVERLAYS, ADMIN_E2E_ROUTES, ADMIN_REDIRECT_PATHS } from '../e2e/admin-routes';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_FILE = join(WEB, 'src', 'app', 'app.routes.ts');

interface ParsedRoute {
  readonly path: string;
  readonly redirect: boolean;
}

/** Router paths in the admin block, normalised to full `admin/...` paths. */
function adminRoutes(source: string): ParsedRoute[] {
  const start = source.indexOf("path: 'admin/login'");
  expect(start, 'admin/login route in app.routes.ts').toBeGreaterThan(-1);
  const rest = source.slice(start);
  // The admin block ends at the first top-level route (4-space indent,
  // children sit deeper) whose path isn't an admin path.
  const end = rest.search(/\n {4}path: '(?!admin)/);
  const block = end === -1 ? rest : rest.slice(0, end);
  // `admin` appears twice: the shell parent (no page of its own) and its
  // `''` child, a redirect to leads. A path counts as a redirect when any
  // entry for it redirects.
  const routes = new Map<string, boolean>();
  const re = /path: '([^']*)',(\s*redirectTo)?/g;
  for (let m = re.exec(block); m; m = re.exec(block)) {
    const raw = m[1]!;
    const path = raw.startsWith('admin') ? raw : raw === '' ? 'admin' : `admin/${raw}`;
    routes.set(path, (routes.get(path) ?? false) || Boolean(m[2]));
  }
  return [...routes].map(([path, redirect]): ParsedRoute => ({ path, redirect }));
}

describe('#548 admin e2e covers every admin route', () => {
  const routes = adminRoutes(readFileSync(ROUTES_FILE, 'utf8'));
  const visited = new Set(ADMIN_E2E_ROUTES.map((r) => r.path));
  const redirects = new Set(ADMIN_REDIRECT_PATHS);

  it('finds the admin routes', () => {
    expect(routes.map((r) => r.path)).toEqual(
      expect.arrayContaining(['admin/login', 'admin/leads', 'admin/billing/invoices', 'admin/api-keys']),
    );
  });

  it('visits every non-redirect admin route', () => {
    const missing = routes.filter((r) => !r.redirect && !visited.has(r.path)).map((r) => r.path);
    expect(missing).toEqual([]);
  });

  it('lists exactly the redirect-only admin routes as skipped', () => {
    const actual = routes.filter((r) => r.redirect).map((r) => r.path).sort();
    expect([...redirects].sort()).toEqual(actual);
  });

  it('has no stale e2e entries for removed routes', () => {
    const known = new Set(routes.map((r) => r.path));
    const stale = ADMIN_E2E_ROUTES.filter((r) => !known.has(r.path)).map((r) => r.path);
    expect(stale).toEqual([]);
  });

  it('uses unique screenshot names', () => {
    const names = [...ADMIN_E2E_ROUTES.map((r) => r.name), ...ADMIN_E2E_OVERLAYS.map((o) => o.name)];
    expect(new Set(names).size).toBe(names.length);
  });

  it('opens an overlay on every admin page that has a drawer', () => {
    const drawerPages = ['/admin/leads', '/admin/builders', '/admin/users', '/admin/billing/invoices', '/admin/disputes', '/admin/api-keys'];
    const opened = new Set(ADMIN_E2E_OVERLAYS.filter((o) => !o.trigger).map((o) => o.url.split('?')[0]));
    expect(drawerPages.filter((p) => !opened.has(p))).toEqual([]);
  });
});
