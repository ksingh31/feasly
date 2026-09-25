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
