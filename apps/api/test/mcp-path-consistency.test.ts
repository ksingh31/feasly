/**
 * #765 (go-live AC7): the MCP endpoint path is the same everywhere.
 *
 * `apps/api/mcp/function.json` route `mcp/v1` + the Functions `api` route
 * prefix = public path `POST /api/mcp/v1`. The registry, the transport
 * decision, the package README and the developer-facing docs must all say
 * that — never the bare `/mcp/v1`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_REGISTRY } from '../src/registry/route-registry';

const API_DIR = join(__dirname, '..');
const REPO = join(API_DIR, '..', '..');

const PUBLIC_PATH = '/api/mcp/v1';

/** Docs that describe the MCP mount. */
const DOCS = [
  'docs/mcp-transport-decision.md',
  'packages/mcp/README.md',
  'docs/plan/TECH_PLAN.md',
  'docs/security/rate-limits.md',
  'docs/plan/epics/07-public-api-mcp.md',
];

/** Source files whose comments name the mount. */
const SOURCES = [
  'apps/api/src/composition.ts',
  'apps/api/src/functions/mcp.ts',
  'apps/api/src/routes/mcp.route.ts',
];

/** `/mcp/v1` not preceded by `/api` — the stale form. */
const BARE_PATH = /(?<!\/api)\/mcp\/v1/;

function read(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8');
}

describe('MCP path consistency (#765 AC7)', () => {
  it('function.json route + the api prefix is the registry path', () => {
    const fn = JSON.parse(read('apps/api/mcp/function.json')) as {
      bindings: { type: string; route?: string; methods?: string[] }[];
    };
    const trigger = fn.bindings.find((b) => b.type === 'httpTrigger')!;
    expect(`/api/${trigger.route}`).toBe(PUBLIC_PATH);
    expect(trigger.methods).toContain('post');

    const hostRoutePrefix =
      (JSON.parse(read('apps/api/host.json')) as {
        extensions?: { http?: { routePrefix?: string } };
      }).extensions?.http?.routePrefix ?? 'api';
    expect(hostRoutePrefix).toBe('api');

    const entries = ROUTE_REGISTRY.filter((r) => r.path.includes('mcp'));
    expect(entries.map((e) => `${e.method} ${e.path}`)).toEqual([
      `POST ${PUBLIC_PATH}`,
    ]);
  });

  it.each([...DOCS, ...SOURCES])('%s names /api/mcp/v1, never the bare /mcp/v1', (rel) => {
    const text = read(rel);
    const stale = text
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => BARE_PATH.test(line));
    expect(stale.map(({ n, line }) => `${rel}:${n}: ${line.trim()}`)).toEqual([]);
  });

  it('the transport decision and README state the public path', () => {
    expect(read('docs/mcp-transport-decision.md')).toContain(PUBLIC_PATH);
    expect(read('packages/mcp/README.md')).toContain(PUBLIC_PATH);
  });
});
