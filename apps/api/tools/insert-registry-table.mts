import { renderRegistryTable, ROUTE_REGISTRY } from '../src/registry/route-registry';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const table = renderRegistryTable();

const toolsDir = dirname(fileURLToPath(import.meta.url));
// tools/ lives at <repo>/apps/api/tools — the doc is three levels up.
const p = join(toolsDir, '..', '..', '..', 'docs', 'plan', 'TECH_PLAN.md');
const doc = readFileSync(p, 'utf8');
const lines = doc.split('\n');
const headerIdx = lines.findIndex((l) => l.startsWith('| Method | Path |'));
if (headerIdx === -1) {
  throw new Error('frozen table header not found in TECH_PLAN.md');
}
// The table runs from its header to EOF: everything after the header must
// be a table row, otherwise refuse to rewrite.
const tail = lines.slice(headerIdx);
if (!tail.every((l) => l === '' || l.startsWith('|'))) {
  throw new Error('non-table content after the frozen table header; refusing to rewrite');
}
const next = [...lines.slice(0, headerIdx), ...table.split('\n'), ''].join('\n');
writeFileSync(p, next);
console.log('inserted ' + ROUTE_REGISTRY.length + ' routes into TECH_PLAN.md');
