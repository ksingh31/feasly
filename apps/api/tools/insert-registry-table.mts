import { renderRegistryTable, ROUTE_REGISTRY } from '../src/registry/route-registry';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const table = renderRegistryTable();
const section =
  '## 16. Canonical API route registry (frozen \u2014 api-mcp/08)\n\n' +
  '> **This table is generated from `apps/api/src/registry/route-registry.ts`.**\n' +
  '> Do not edit it by hand \u2014 add the route to the registry first, then\n' +
  '> regenerate. CI (`test/route-registry.conformance.test.ts`) fails if this\n' +
  '> table drifts from the registry, if any deployed Function binding names a\n' +
  '> route not in the registry, or if any `/api/v1/\u2026` literal in the codebase\n' +
  '> does not resolve to a registry entry.\n' +
  '>\n' +
  '> `status: live` = Function binding exists on main. `status: planned` = a\n' +
  '> story references it; implementation must use exactly this method + path.\n\n' +
  table +
  '\n\n';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const p = join(toolsDir, '..', '..', '..', 'docs', 'plan', 'TECH_PLAN.md');
let doc = readFileSync(p, 'utf8');
const endMarker = '*End of TECH_PLAN.md';
if (doc.includes('## 16. Canonical API route registry')) {
  doc = doc.replace(
    /## 16\. Canonical API route registry[\s\S]*?(?=\n---\n\n\*End of TECH_PLAN\.md)/,
    section.trimEnd(),
  );
} else {
  doc = doc.replace('---\n\n' + endMarker, section + '---\n\n' + endMarker);
}
writeFileSync(p, doc);
console.log('inserted ' + ROUTE_REGISTRY.length + ' routes into TECH_PLAN.md');
