/**
 * Community-stats staleness threshold parity (neighbourhood/05 AC4).
 *
 * The CI guard (`infra/health/check-community-stats-freshness.sh`) and the
 * API's `stale` flag (`STALE_AFTER_DAYS` in
 * src/routes/community-stats.route.ts) must use the same day count —
 * otherwise CI and the API disagree about what "stale" means. This test
 * fails the build if the two drift apart.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STALE_AFTER_DAYS } from '../src/routes/community-stats.route';

const REPO_ROOT = join(__dirname, '..', '..', '..');

function extractScriptDefault(): number {
  const script = readFileSync(
    join(REPO_ROOT, 'infra', 'health', 'check-community-stats-freshness.sh'),
    'utf8',
  );
  const match = script.match(/STALE_AFTER_DAYS="\$\{STALE_AFTER_DAYS:-(\d+)\}"/);
  if (!match) {
    throw new Error(
      'could not find STALE_AFTER_DAYS default in check-community-stats-freshness.sh',
    );
  }
  return Number(match[1]);
}

describe('community-stats staleness threshold parity', () => {
  it('CI guard default matches the API stale-flag constant', () => {
    expect(extractScriptDefault()).toBe(STALE_AFTER_DAYS);
  });

  it('the threshold is the story value (45 days)', () => {
    expect(STALE_AFTER_DAYS).toBe(45);
  });
});
