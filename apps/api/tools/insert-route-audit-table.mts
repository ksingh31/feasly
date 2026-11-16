/**
 * #731: regenerate the route-audit table in docs/security/route-audit.md
 * from the route registry + audit notes. Run:
 * `npx tsx tools/insert-route-audit-table.mts` (from apps/api).
 * The conformance test fails CI until the doc matches.
 */
import {
  ROUTE_AUDIT_TABLE_BEGIN,
  ROUTE_AUDIT_TABLE_END,
  renderRouteAuditTable,
} from '../src/registry/route-audit';
import { ROUTE_REGISTRY } from '../src/registry/route-registry';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
// tools/ lives at <repo>/apps/api/tools — the doc is three levels up.
const p = join(toolsDir, '..', '..', '..', 'docs', 'security', 'route-audit.md');
const doc = readFileSync(p, 'utf8');
const start = doc.indexOf(ROUTE_AUDIT_TABLE_BEGIN);
const end = doc.indexOf(ROUTE_AUDIT_TABLE_END);
if (start === -1 || end === -1 || end < start) {
  throw new Error('generated-table markers not found in docs/security/route-audit.md');
}
const next =
  doc.slice(0, start + ROUTE_AUDIT_TABLE_BEGIN.length) +
  '\n' +
  renderRouteAuditTable() +
  '\n' +
  doc.slice(end);
writeFileSync(p, next);
console.log('wrote ' + ROUTE_REGISTRY.length + ' routes into docs/security/route-audit.md');
