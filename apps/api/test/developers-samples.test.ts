/**
 * /developers code-sample contract test (api-mcp/03 AC3).
 *
 * The quickstart curl samples on the developers page are validated against
 * the generated OpenAPI spec, so a stale sample fails CI:
 * - the sample's path + HTTP method must exist in the spec
 * - query params used by the sample must be declared on the operation
 * - a sample request body must parse as JSON and validate against the
 *   operation's zod request schema
 * - operations that declare a security scheme must show an Authorization
 *   header in the sample
 *
 * Samples are extracted from the Angular template (<pre><code> blocks
 * starting with `curl`); {{ }} interpolations are resolved from the
 * component's own constants, so the test follows the page if they change.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpenApiSpec } from '../src/openapi/spec';
import { EstimateRequestSchema } from '../src/openapi/schemas';

const API_ROOT = join(__dirname, '..');
const APPS_ROOT = join(API_ROOT, '..');
const HTML_PATH = join(
  APPS_ROOT,
  'web/src/app/features/developers/developers-page.component.html',
);
const COMPONENT_PATH = join(
  APPS_ROOT,
  'web/src/app/features/developers/developers-page.component.ts',
);

/** OpenAPI component schema name -> the zod schema the spec is built from. */
const REQUEST_SCHEMAS: Record<string, { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } }> = {
  EstimateRequest: EstimateRequestSchema,
};

interface ParsedCurl {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly data: string | null;
  readonly raw: string;
}

/** Resolve {{ name }} and {{'...'}} interpolations using the component constants. */
function resolveInterpolations(block: string): string {
  const component = readFileSync(COMPONENT_PATH, 'utf8');
  const consts: Record<string, string> = {};
  for (const m of component.matchAll(/readonly (\w+) = '([^']+)'/g)) {
    consts[m[1]] = m[2];
  }
  return block
    .replace(/\{\{\s*'((?:[^'\\]|\\.)*)'\s*\}\}/g, '$1')
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
      if (!(name in consts)) throw new Error(`unknown interpolation {{ ${name} }}`);
      return consts[name];
    });
}

/** Split a shell command into tokens, respecting quotes and \ continuations. */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let i = 0;
  const push = () => {
    if (cur !== '') tokens.push(cur);
    cur = '';
  };
  while (i < cmd.length) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i++;
      continue;
    }
    if (c === '\\' && cmd[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  push();
  return tokens;
}

function parseCurl(raw: string): ParsedCurl {
  const tokens = tokenize(raw);
  expect(tokens[0]).toBe('curl');
  let method = 'GET';
  const headers: Record<string, string> = {};
  let url = '';
  let data: string | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-X' || t === '--request') {
      method = tokens[++i].toUpperCase();
    } else if (t === '-H' || t === '--header') {
      const hv = tokens[++i];
      const idx = hv.indexOf(':');
      headers[hv.slice(0, idx).trim().toLowerCase()] = hv.slice(idx + 1).trim();
    } else if (t === '-d' || t === '--data' || t === '--data-raw') {
      data = tokens[++i];
    } else if (t.startsWith('http')) {
      url = t;
    }
  }
  expect(url, `sample has no URL: ${raw.slice(0, 80)}`).not.toBe('');
  return { method, url, headers, data, raw };
}

/** Extract the curl samples from the developers page template. */
function extractSamples(): ParsedCurl[] {
  const html = readFileSync(HTML_PATH, 'utf8');
  const blocks = [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map(
    (m) => m[1],
  );
  expect(blocks.length).toBeGreaterThan(0);
  return blocks
    .map((b) => resolveInterpolations(b).trim())
    .filter((b) => b.startsWith('curl'))
    .map(parseCurl);
}

interface SpecOperation {
  parameters?: Array<{ name: string; in: string }>;
  security?: Array<Record<string, string[]>>;
  requestBody?: {
    content?: Record<string, { schema?: { $ref?: string } }>;
  };
}

/** Match a concrete path against spec paths with {param} templates. */
function findSpecPath(
  paths: Record<string, unknown>,
  concrete: string,
): string | null {
  if (concrete in paths) return concrete;
  for (const p of Object.keys(paths)) {
    const pattern =
      '^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}/g, '[^/]+') + '$';
    if (new RegExp(pattern).test(concrete)) return p;
  }
  return null;
}

describe('developers page code samples', () => {
  it('every curl sample matches the generated OpenAPI spec', () => {
    const spec = buildOpenApiSpec({
      siteUrl: 'https://feasly.dev',
      version: '0.0.0-test',
    }) as unknown as {
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, SpecOperation>>;
    };
    const samples = extractSamples();
    expect(samples.length).toBeGreaterThan(0);

    for (const sample of samples) {
      const label = `${sample.method} ${sample.url}`;
      const u = new URL(sample.url);
      const server = spec.servers.find((s) => sample.url.startsWith(s.url));
      expect(server, `${label}: URL is not under a spec server`).toBeDefined();
      const concretePath = u.pathname;
      // Strip the server origin (and any server sub-path) to get the spec path.
      const serverPath = new URL(server!.url).pathname.replace(/\/$/, '');
      const specPath = concretePath.startsWith(serverPath)
        ? concretePath.slice(serverPath.length)
        : concretePath;
      const matched = findSpecPath(spec.paths, specPath || '/');
      expect(matched, `${label}: path ${specPath} not in the OpenAPI spec`).not.toBeNull();

      const operation = spec.paths[matched!]![sample.method.toLowerCase()] as
        | SpecOperation
        | undefined;
      expect(
        operation,
        `${label}: method ${sample.method} not defined for ${matched} in the spec`,
      ).toBeDefined();

      // Query params used by the sample must be declared on the operation.
      const declaredQuery = new Set(
        (operation!.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name),
      );
      for (const key of u.searchParams.keys()) {
        expect(
          declaredQuery.has(key),
          `${label}: query param ?${key} is not declared in the spec`,
        ).toBe(true);
      }

      // A sample body must parse as JSON and satisfy the operation's schema.
      if (sample.data !== null) {
        let body: unknown;
        try {
          body = JSON.parse(sample.data);
        } catch {
          expect.unreachable(`${label}: -d payload is not valid JSON`);
        }
        const ref = operation!.requestBody?.content?.['application/json']?.schema?.$ref;
        expect(ref, `${label}: spec has no JSON requestBody for a body-carrying sample`).toBeDefined();
        const name = ref!.split('/').pop()!;
        const zodSchema = REQUEST_SCHEMAS[name];
        expect(
          zodSchema,
          `${label}: add '${name}' to REQUEST_SCHEMAS in developers-samples.test.ts`,
        ).toBeDefined();
        const result = zodSchema!.safeParse(body);
        expect(
          result.success,
          `${label}: sample body fails ${name} validation: ${result.success ? '' : result.error!.message}`,
        ).toBe(true);
      }

      // Secured operations must show an Authorization header in the sample.
      if (operation!.security && operation!.security.length > 0) {
        expect(
          sample.headers['authorization'],
          `${label}: secured operation sample must include an Authorization header`,
        ).toBeDefined();
      }
    }
  });
});
