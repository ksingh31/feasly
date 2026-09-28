/**
 * HTTP route-binding integrity tests.
 *
 * Regression coverage for the 2026-09-28 admin CSV export outage: the
 * deployed Function App routed `GET /api/v1/admin/leads/export.csv` to the
 * `v1/admin/leads/{id}` trigger (Functions host does not prefer literal
 * segments over route parameters), so the detail handler ran
 * `parseLeadId("export.csv")` and every export failed with
 * "Invalid lead id.".
 *
 * These tests pin the committed function.json bindings:
 *  1. The export literal route exists.
 *  2. The `{id}` sibling carries a `:guid` constraint so it cannot capture
 *     the `export.csv` literal (lead ids are UUIDs — the route layer
 *     enforces `z.string().uuid()`).
 *  3. General guard: no UNCONSTRAINED `{param}` route anywhere in the API
 *     has a literal sibling at the same path depth, so this class of
 *     shadowing cannot be reintroduced for any other endpoint.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// __dirname (not import.meta): the api tsconfig module setting disallows
// import.meta — same convention as the other api tests.
const API_ROOT = join(__dirname, '..');

interface Binding {
  readonly type?: string;
  readonly route?: string;
  readonly methods?: readonly string[];
}

function httpRoutes(): { readonly adapter: string; readonly route: string }[] {
  const out: { adapter: string; route: string }[] = [];
  for (const entry of readdirSync(API_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fj = join(API_ROOT, entry.name, 'function.json');
    if (!existsSync(fj)) continue;
    const parsed = JSON.parse(readFileSync(fj, 'utf8')) as {
      readonly bindings?: readonly Binding[];
    };
    for (const b of parsed.bindings ?? []) {
      if (b.type === 'httpTrigger' && b.route) {
        out.push({ adapter: entry.name, route: b.route });
      }
    }
  }
  return out;
}

function routeFor(adapter: string): string {
  const routes = httpRoutes();
  const hit = routes.find((r) => r.adapter === adapter);
  if (!hit) throw new Error(`no httpTrigger binding found for ${adapter}`);
  return hit.route;
}

describe('http route bindings', () => {
  it('exposes the admin leads CSV export as a literal route', () => {
    expect(routeFor('admin-leads-export')).toBe('v1/admin/leads/export.csv');
  });

  it('constrains the admin lead detail {id} route to GUIDs so it cannot capture export.csv', () => {
    const route = routeFor('admin-leads-detail');
    expect(route).toBe('v1/admin/leads/{id:guid}');
  });

  it('has no unconstrained parameter route with a literal sibling at the same depth', () => {
    const routes = httpRoutes();
    const conflicts: string[] = [];
    for (const { adapter, route } of routes) {
      const segs = route.split('/');
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        // Unconstrained parameter: {name} with no :constraint suffix.
        const m = /^\{([a-zA-Z0-9_]+)\}$/.exec(seg);
        if (!m) continue;
        const prefix = segs.slice(0, i).join('/');
        for (const other of routes) {
          if (other.adapter === adapter) continue;
          const oSegs = other.route.split('/');
          if (
            oSegs.length === segs.length &&
            oSegs.slice(0, i).join('/') === prefix &&
            !oSegs[i].startsWith('{')
          ) {
            conflicts.push(
              `${adapter} (${route}) shadows literal ${other.adapter} (${other.route})`,
            );
          }
        }
        break; // one parameter per route is enough to flag the route
      }
    }
    expect(conflicts).toEqual([]);
  });
});
