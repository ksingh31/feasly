/**
 * Emits the generated OpenAPI 3.1 spec to a JSON file (api-mcp/03).
 *
 * Used by `npm run openapi:lint` (Redocly validation) and as the spec
 * artifact for contract tests. The spec is generated at build time from
 * the zod schemas, so the emitted file is a build artifact, never source.
 *
 * Local: `npx tsx tools/emit-openapi.ts [outPath]` (defaults to openapi.json)
 */
import { writeFileSync } from 'node:fs';
import { buildOpenApiSpec } from '../src/openapi/spec';

const outPath = process.argv[2] ?? 'openapi.json';
// Fixed site/version keep the emitted artifact stable; structural lint does
// not depend on these values.
const spec = buildOpenApiSpec({
  siteUrl: 'https://feasly.dev',
  version: '0.0.0-ci',
});
writeFileSync(outPath, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`wrote ${outPath}`);
