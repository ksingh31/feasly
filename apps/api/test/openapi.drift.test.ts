/**
 * OpenAPI drift test (api-mcp/03).
 *
 * Regenerates the spec from the zod schemas and verifies it matches
 * the checked-in snapshot. If the schemas change without updating the
 * snapshot, this test fails — forcing the spec to stay in sync.
 *
 * To update the snapshot after an intentional schema change:
 *   npm run test -- openapi.drift.test.ts -u
 * (then review the diff carefully before committing)
 */
import { describe, it, expect } from 'vitest';
import { buildOpenApiSpec } from '../src/openapi/spec';

describe('OpenAPI drift', () => {
  it('generated spec matches the snapshot', async () => {
    const spec = buildOpenApiSpec({
      siteUrl: 'https://feasly.dev',
      version: '0.0.0-test',
    });

    // Snapshot the full spec — any schema change triggers a diff.
    // Use a fixed version so the snapshot is stable across releases.
    expect(spec).toMatchSnapshot();
  });

  it('spec has no unresolved $refs', async () => {
    const spec = buildOpenApiSpec({
      siteUrl: 'https://feasly.dev',
      version: '0.0.0-test',
    });

    const json = JSON.stringify(spec);
    // All $refs should point to #/components/ (resolvable within the doc)
    const refs = json.match(/"\$ref":"([^"]+)"/g) ?? [];
    for (const ref of refs) {
      expect(ref).toMatch(/#\/components\//);
    }
  });
});
