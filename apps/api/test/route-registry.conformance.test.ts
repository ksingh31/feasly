/**
 * API route registry conformance (api-mcp/08).
 *
 * The registry (`src/registry/route-registry.ts`) is the single source of
 * truth for every Feasly API route. These tests fail CI if:
 *  1. Any deployed Function binding (function.json) names a route+method
 *     that is not in the registry (route drift).
 *  2. Any path in the generated OpenAPI spec is not in the registry.
 *  3. Any `/api/v1/…` literal in src/ or test/ (outside the registry itself
 *     and this test) does not resolve to a registry entry — this catches
 *     contradicting route names like the old `/api/v1/estimates` plural.
 *  4. The frozen table in docs/plan/TECH_PLAN.md (§16) drifts from
 *     `renderRegistryTable()`.
 *
 * Story files live outside this repo; they were audited manually for
 * api-mcp/08 and amended to the canonical names. New stories must use the
 * registry names — the grep in (3) covers everything CI can see.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  registryKeys,
  renderRegistryTable,
  resolveToRegistry,
  ROUTE_REGISTRY,
  type HttpMethod,
} from '../src/registry/route-registry';
import { buildOpenApiSpec } from '../src/openapi/spec';
import {
  effectivePermissions,
  hasPermission,
  PERMISSIONS,
  type Permission,
} from '../src/auth/permissions';
import type { BuilderRole, StaffRole } from '../src/services/user.service';

const API_ROOT = join(__dirname, '..');
const REPO_ROOT = join(API_ROOT, '..', '..');

function allFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...allFiles(full, ext));
    } else if (entry.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip // and block comments so prose can't trip the scanners. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

const ROUTE_LITERAL_RE = /\/api\/v1\/[A-Za-z0-9/_{}.$-]+/g;

// Files allowed to mention routes without resolving (the registry + this test).
function isExempt(file: string): boolean {
  const rel = relative(API_ROOT, file).split(sep).join('/');
  return (
    rel === 'src/registry/route-registry.ts' ||
    rel === 'src/registry/index.ts' ||
    rel === 'test/route-registry.conformance.test.ts'
  );
}

describe('route registry', () => {
  it('has no duplicate method+path entries', () => {
    const keys = ROUTE_REGISTRY.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every entry has method + auth + rate limit (acceptance criterion 1)', () => {
    for (const e of ROUTE_REGISTRY) {
      expect(e.method, `${e.path} method`).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/);
      expect(e.auth, `${e.path} auth`).toBeTruthy();
      expect(e.rateLimit, `${e.path} rateLimit`).toBeTruthy();
      expect(e.path, `${e.path} prefix`).toMatch(/^\/api\//);
    }
  });

  it('every entry explicitly declares permissions (auth/04 — CI fails when missing)', () => {
    const known = new Set<string>(PERMISSIONS as readonly string[]);
    for (const e of ROUTE_REGISTRY) {
      // Deliberately strict: the property must exist and be an array.
      // `[]` is the explicit "no permission check" declaration (public
      // routes, or routes where the credential mechanism IS the
      // authorization: magic token, API-key scopes, Stripe signature).
      expect(
        Array.isArray(e.permissions),
        `${e.method} ${e.path} must declare permissions`,
      ).toBe(true);
      for (const p of e.permissions) {
        expect(known.has(p), `${e.method} ${e.path} unknown permission ${p}`).toBe(
          true,
        );
      }
    }
  });

  it('role x route permission matrix (auth/04)', () => {
    // Fixture users: staff role plus membership roles, resolved through
    // the same effectivePermissions() the middleware uses.
    const fixtures: Record<string, { staff: StaffRole | null; members: BuilderRole[] }> = {
      super_admin: { staff: 'super_admin', members: [] },
      admin: { staff: 'admin', members: [] },
      viewer: { staff: 'viewer', members: [] },
      builder_admin: { staff: null, members: ['builder_admin'] },
      builder_member: { staff: null, members: ['builder_member'] },
      none: { staff: null, members: [] },
    };
    const permsOf = (role: string): readonly Permission[] =>
      effectivePermissions(fixtures[role]!.staff, fixtures[role]!.members);

    // method, path → roles allowed through requirePermission.
    const expected: Record<string, readonly string[]> = {
      'GET /api/v1/admin/leads': ['super_admin', 'admin', 'viewer'],
      'POST /api/v1/admin/leads/{id}/notes': ['super_admin', 'admin'],
      'POST /api/v1/admin/leads/{id}/assign-builder': ['super_admin', 'admin'],
      'GET /api/v1/admin/builders': ['super_admin', 'admin', 'viewer'],
      'POST /api/v1/admin/builders': ['super_admin', 'admin'],
      'GET /api/v1/admin/api-keys': ['super_admin', 'admin'],
      'GET /api/v1/admin/billing': ['super_admin', 'admin', 'viewer'],
      'POST /api/v1/billing/invoices/{id}/resolve': ['super_admin', 'admin'],
      'GET /api/v1/admin/disputes': ['super_admin', 'admin', 'viewer'],
      'POST /api/v1/admin/community-stats/refresh': ['super_admin', 'admin'],
      'GET /api/v1/builder/leads': [
        'super_admin',
        'admin',
        'builder_admin',
        'builder_member',
      ],
      'PATCH /api/v1/builder/leads/{id}': [
        'super_admin',
        'admin',
        'builder_admin',
        'builder_member',
      ],
      'POST /api/v1/billing/report-contract': [
        'super_admin',
        'admin',
        'builder_admin',
      ],
      'POST /api/v1/admin/view-as': ['super_admin', 'admin'],
      // No permission check — the credential mechanism is the authorization.
      'POST /api/v1/estimate': [
        'super_admin',
        'admin',
        'viewer',
        'builder_admin',
        'builder_member',
        'none',
      ],
      'POST /api/v1/admin/auth/entra/callback': [
        'super_admin',
        'admin',
        'viewer',
        'builder_admin',
        'builder_member',
        'none',
      ],
      'POST /api/mcp/v1': [
        'super_admin',
        'admin',
        'viewer',
        'builder_admin',
        'builder_member',
        'none',
      ],
      'POST /api/v1/stripe/webhooks': [
        'super_admin',
        'admin',
        'viewer',
        'builder_admin',
        'builder_member',
        'none',
      ],
    };

    for (const [key, allowedRoles] of Object.entries(expected)) {
      const [method, path] = key.split(' ', 2);
      const entry = ROUTE_REGISTRY.find(
        (e) => e.method === method && e.path === path,
      );
      expect(entry, `registry entry for ${key}`).toBeDefined();
      for (const role of Object.keys(fixtures)) {
        const allowed = entry!.permissions.every((p) =>
          hasPermission(permsOf(role), p),
        );
        expect(
          allowed,
          `${key}: role ${role}`,
        ).toBe(allowedRoles.includes(role));
      }
    }
  });

  it('exhaustive role x route permission matrix (auth/04 acceptance criterion 1)', () => {
    // Every registry entry x every role, generated from the registry.
    // `permissions: []` routes sit outside role-permission authorization
    // (credential mechanisms: magic links, webhooks, API keys, public
    // reads) — every role passes the role check there.
    const fixtures: Record<
      string,
      { staff: StaffRole | null; members: BuilderRole[] }
    > = {
      super_admin: { staff: 'super_admin', members: [] },
      admin: { staff: 'admin', members: [] },
      viewer: { staff: 'viewer', members: [] },
      builder_admin: { staff: null, members: ['builder_admin'] },
      builder_member: { staff: null, members: ['builder_member'] },
      none: { staff: null, members: [] },
    };
    const roles = Object.keys(fixtures);
    const permsOf = (role: string): readonly Permission[] =>
      effectivePermissions(fixtures[role]!.staff, fixtures[role]!.members);

    const matrix: Record<string, string[]> = {};
    for (const e of ROUTE_REGISTRY) {
      const key = `${e.method} ${e.path}`;
      matrix[key] =
        e.permissions.length === 0
          ? [...roles]
          : roles.filter((r) =>
              e.permissions.every((p) => hasPermission(permsOf(r), p)),
            );
    }

    // A valid user with no roles/memberships gets empty access: denied on
    // every protected route.
    for (const e of ROUTE_REGISTRY) {
      if (e.permissions.length === 0) continue;
      expect(
        matrix[`${e.method} ${e.path}`],
        `${e.method} ${e.path} must deny the role-less user`,
      ).not.toContain('none');
    }

    // viewer is read-only: denied everywhere a write/manage permission is required.
    for (const e of ROUTE_REGISTRY) {
      if (e.permissions.some((p) => /:(manage|write)$/.test(p))) {
        expect(
          matrix[`${e.method} ${e.path}`],
          `${e.method} ${e.path} must deny viewer (read-only)`,
        ).not.toContain('viewer');
      }
    }

    // super_admin can do everything the role model authorizes.
    for (const e of ROUTE_REGISTRY) {
      if (e.permissions.length === 0) continue;
      expect(
        matrix[`${e.method} ${e.path}`],
        `${e.method} ${e.path} must allow super_admin`,
      ).toContain('super_admin');
    }

    // Frozen matrix snapshot: any change to ROLE_PERMISSIONS or a route's
    // declared permissions shows up here as a diff to review.
    expect(matrix).toMatchSnapshot();
  });

  it('every protected HTTP adapter executes registry permission enforcement (auth/04)', () => {
    // Registry declarations alone are not authorization: each protected
    // route's adapter must hand its exact registry path to the central
    // enforcement helper (via the shared dispatch `path` opt, or a direct
    // enforceRoutePermissions call for bespoke adapters).
    const failures: string[] = [];
    for (const f of allFiles(join(API_ROOT, 'src', 'functions'), '.json')) {
      if (!f.endsWith('function.json')) continue;
      const doc = JSON.parse(readFileSync(f, 'utf8')) as {
        bindings?: Array<{ type?: string; methods?: string[]; route?: string }>;
      };
      const adapter = `${f.slice(0, -'function.json'.length)}.ts`;
      let code: string;
      try {
        code = readFileSync(adapter, 'utf8');
      } catch {
        failures.push(`${relative(API_ROOT, f)}: adapter source missing`);
        continue;
      }
      for (const b of doc.bindings ?? []) {
        if (b.type !== 'httpTrigger' || !b.route) continue;
        for (const m of b.methods ?? []) {
          if (m.toLowerCase() === 'options') continue;
          const full =
            b.route === 'health' ? '/api/health' : `/api/${b.route}`;
          const key = resolveToRegistry(m.toUpperCase() as HttpMethod, full);
          if (!key) continue; // covered by the binding-resolution test
          const [method, path] = key.split(' ', 2);
          const entry = ROUTE_REGISTRY.find(
            (e) => e.method === method && e.path === path,
          );
          // Public/credential routes (permissions: []) keep their own auth.
          if (!entry || entry.permissions.length === 0) continue;
          const stripped = stripComments(code);
          const viaDispatch =
            stripped.includes(`path: '${path}'`) ||
            stripped.includes(`path: "${path}"`);
          const viaDirect =
            stripped.includes('enforceRoutePermissions') &&
            stripped.includes(path);
          if (!viaDispatch && !viaDirect) {
            failures.push(
              `${m.toUpperCase()} ${full}: adapter does not pass '${path}' ` +
                'to permission enforcement',
            );
          }
        }
      }
    }
    expect(
      failures,
      'HTTP adapters missing registry permission enforcement',
    ).toEqual([]);
  });

  it('every deployed Function binding resolves to a registry entry', () => {
    const bindings: Array<{ file: string; method: string; route: string }> = [];
    for (const f of allFiles(API_ROOT, '.json')) {
      if (!f.endsWith('function.json')) continue;
      const doc = JSON.parse(readFileSync(f, 'utf8')) as {
        bindings?: Array<{ type?: string; methods?: string[]; route?: string }>;
      };
      for (const b of doc.bindings ?? []) {
        if (b.type !== 'httpTrigger' || !b.route) continue;
        for (const m of b.methods ?? []) {
          if (m.toLowerCase() === 'options') continue; // CORS preflight, not a route
          bindings.push({ file: f, method: m.toUpperCase(), route: `/api/${b.route}` });
        }
      }
    }
    expect(bindings.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const b of bindings) {
      const key = resolveToRegistry(b.method as HttpMethod, b.route);
      if (!key) missing.push(`${b.method} ${b.route} (${relative(API_ROOT, b.file)})`);
    }
    expect(missing, 'function.json bindings missing from the route registry').toEqual([]);
  });

  it('every OpenAPI spec path resolves to a registry entry', () => {
    const spec = buildOpenApiSpec({ siteUrl: 'https://feasly.dev', version: '0.0.0-test' }) as {
      paths?: Record<string, Record<string, unknown>>;
    };
    const paths = Object.keys(spec.paths ?? {});
    expect(paths.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const p of paths) {
      // Spec paths are relative to the /api base (served at /api/v1/openapi.json).
      const full = `/api${p}`;
      const methods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
      const resolved = methods.some(
        (method) => resolveToRegistry(method, full) !== null,
      );
      if (!resolved) missing.push(full);
    }
    expect(missing, 'OpenAPI paths missing from the route registry').toEqual([]);
  });

  it('every /api/v1/… literal in src/ and test/ resolves to a registry entry', () => {
    const keys = registryKeys();
    const unresolvable: string[] = [];
    const files = [
      ...allFiles(join(API_ROOT, 'src'), '.ts'),
      ...allFiles(join(API_ROOT, 'test'), '.ts'),
    ];
    for (const file of files) {
      if (isExempt(file)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      // Skip the OpenAPI drift snapshot — covered by its own test.
      if (file.includes('__snapshots__')) continue;
      ROUTE_LITERAL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ROUTE_LITERAL_RE.exec(code)) !== null) {
        const raw = m[0].replace(/[.,;:!?)\]]+$/, '');
        // Prefix mentions (e.g. "/api/v1/admin/" in prose) are not routes.
        if (raw.endsWith('/')) continue;
        // Try every method: the literal must resolve for at least one.
        const methods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        const resolved = methods.some(
          (method) => resolveToRegistry(method, raw) !== null,
        );
        if (!resolved) {
          unresolvable.push(`${raw} (${relative(API_ROOT, file)})`);
        }
      }
    }
    // Dedupe for a readable failure message.
    const unique = [...new Set(unresolvable)];
    expect(
      unique,
      'route literals that do not resolve to the canonical registry — ' +
        'add the route to src/registry/route-registry.ts first, or fix the name',
    ).toEqual([]);
  });

  it('TECH_PLAN.md §16 frozen table matches the registry', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'plan', 'TECH_PLAN.md'), 'utf8');
    const expected = renderRegistryTable();
    expect(
      doc.includes(expected),
      'docs/plan/TECH_PLAN.md §16 table is out of sync with ' +
        'src/registry/route-registry.ts — regenerate it from renderRegistryTable()',
    ).toBe(true);
  });
});
