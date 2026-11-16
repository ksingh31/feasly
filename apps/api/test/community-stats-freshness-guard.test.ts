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
import { loadConfig } from '../src/config';

const REPO_ROOT = join(__dirname, '..', '..', '..');

function readScript(): string {
  return readFileSync(
    join(REPO_ROOT, 'infra', 'health', 'check-community-stats-freshness.sh'),
    'utf8',
  );
}

function extractScriptDefault(): number {
  const script = readScript();
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

describe('community-lots staleness threshold parity (#691)', () => {
  it('CI guard lots default matches COMMUNITY_LOTS_STALE_AFTER_DAYS default', () => {
    const match = readScript().match(
      /LOTS_STALE_AFTER_DAYS="\$\{LOTS_STALE_AFTER_DAYS:-(\d+)\}"/,
    );
    expect(match).not.toBeNull();
    const config = loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost:5432/feasly' });
    expect(Number(match?.[1])).toBe(config.communityLots.staleAfterDays);
  });

  it('the lots check skips cleanly before the table exists (no false alarm on deploy)', () => {
    expect(readScript()).toContain("to_regclass('public.community_lot_refreshes')");
  });
});
