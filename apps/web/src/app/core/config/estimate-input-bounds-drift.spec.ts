/**
 * Estimate-bounds drift tripwire.
 *
 * `limits.minLotSizeSqft/maxLotSizeSqft/minAssessedLandValue/maxAssessedLandValue`
 * in DEFAULT_APP_CONFIG mirror the `inputBounds` of the cost-data file the
 * API's pricing engine enforces. The property record arrives direct from
 * Socrata (propertyData.source 'live'), so the client needs these numbers
 * for the early lot-coverage guard — but the cost-data file is the single
 * source of truth. If the cost data's bounds ever change, this spec fails
 * until the config mirror is updated alongside it.
 *
 * The cost-data file under test is the one the engine's placeholder import
 * points at (packages/cost-engine/src/cost-data.ts), resolved dynamically
 * so a version bump can't silently test the wrong file.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from './app-config.defaults';

const here = dirname(fileURLToPath(import.meta.url));
// apps/web/src/app/core/config -> repo root
const REPO_ROOT = join(here, '..', '..', '..', '..', '..', '..');

function pinnedCostDataPath(): string {
  const src = readFileSync(join(REPO_ROOT, 'packages', 'cost-engine', 'src', 'cost-data.ts'), 'utf8');
  const match = src.match(/from '\.\.\/cost-data\/([\w.\-]+\.json)'/);
  if (!match) throw new Error('drift spec: cannot find the pinned cost-data import in cost-data.ts');
  return join(REPO_ROOT, 'packages', 'cost-engine', 'cost-data', match[1]);
}

describe('estimate input-bounds drift', () => {
  it('config limits mirror the cost-data inputBounds the engine enforces', () => {
    const costData = JSON.parse(readFileSync(pinnedCostDataPath(), 'utf8')) as {
      inputBounds: Record<string, number>;
    };
    const bounds = costData.inputBounds;
    const limits = DEFAULT_APP_CONFIG.limits;
    expect(limits.minLotSizeSqft).toBe(bounds['minLotSizeSqft']);
    expect(limits.maxLotSizeSqft).toBe(bounds['maxLotSizeSqft']);
    expect(limits.minAssessedLandValue).toBe(bounds['minAssessedLandValue']);
    expect(limits.maxAssessedLandValue).toBe(bounds['maxAssessedLandValue']);
  });
});
