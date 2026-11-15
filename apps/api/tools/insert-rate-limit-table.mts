/**
 * #729: regenerate the rate-limit table in docs/security/rate-limits.md
 * from the route registry. Run: `npx tsx tools/insert-rate-limit-table.mts`
 * (from apps/api). The conformance test fails CI until the doc matches.
 */
import {
  RATE_LIMIT_TABLE_BEGIN,
  RATE_LIMIT_TABLE_END,
  renderRateLimitTable,
  ROUTE_REGISTRY,
} from '../src/registry/route-registry';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
// tools/ lives at <repo>/apps/api/tools — the doc is three levels up.
const p = join(toolsDir, '..', '..', '..', 'docs', 'security', 'rate-limits.md');
const doc = readFileSync(p, 'utf8');
const start = doc.indexOf(RATE_LIMIT_TABLE_BEGIN);
const end = doc.indexOf(RATE_LIMIT_TABLE_END);
if (start === -1 || end === -1 || end < start) {
  throw new Error('generated-table markers not found in docs/security/rate-limits.md');
}
const next =
  doc.slice(0, start + RATE_LIMIT_TABLE_BEGIN.length) +
  '\n' +
  renderRateLimitTable() +
  '\n' +
  doc.slice(end);
writeFileSync(p, next);
console.log('wrote ' + ROUTE_REGISTRY.length + ' routes into docs/security/rate-limits.md');
