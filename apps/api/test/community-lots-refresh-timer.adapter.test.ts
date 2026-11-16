/**
 * Community-lots refresh timer adapter (#691): one refresh per run, counts
 * + duration logged (no addresses), a failed run throws so the Functions
 * host records it, and the weekly schedule is pinned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const runRefreshCycle = vi.fn();
const fakeApp = { communityLotsRefreshService: { runRefreshCycle } };

vi.mock('../src/index', () => ({ createComposition: () => fakeApp }));

import { communityLotsRefreshTimerHandler } from '../src/functions/community-lots-refresh-timer';

const RESULT = {
  status: 'ok',
  rollYear: '2026',
  communities: 114,
  failedCommunities: 0,
  listed: 640,
  inserted: 5,
  updated: 2,
  unchanged: 633,
  removed: 1,
  communitiesRemoved: 0,
  excluded: {
    unparseable: 0,
    'not-residential-vacant': 0,
    'no-assessed-value': 0,
    sliver: 12,
    'district-not-allowed': 549,
  },
  refreshedAt: new Date('2026-11-16T09:31:00Z'),
  durationMs: 61_000,
  consecutiveFailures: 0,
};

beforeEach(() => {
  runRefreshCycle.mockReset();
  runRefreshCycle.mockResolvedValue(RESULT);
});

describe('community-lots-refresh-timer adapter', () => {
  it('runs one cycle and logs counts + measured duration only', async () => {
    const logs: unknown[][] = [];
    await communityLotsRefreshTimerHandler({ log: (...a: unknown[]) => void logs.push(a) });
    expect(runRefreshCycle).toHaveBeenCalledTimes(1);
    const line = String(logs[0]![0]);
    expect(line).toContain('community-lots-refresh-timer: ok');
    expect(line).toContain('listed=640');
    expect(line).toContain('excluded_sliver=12');
    expect(line).toContain('duration_ms=61000');
    expect(line).not.toMatch(/ ST | AV /);
  });

  it('throws when any community failed (host records the failure)', async () => {
    runRefreshCycle.mockResolvedValue({ ...RESULT, status: 'failed', failedCommunities: 2 });
    await expect(communityLotsRefreshTimerHandler({ log: () => {} })).rejects.toThrow(
      /2 community\(ies\) failed/,
    );
  });

  it('is scheduled weekly (Monday 09:30 UTC)', () => {
    const fn = JSON.parse(
      readFileSync(join(__dirname, '..', 'community-lots-refresh-timer', 'function.json'), 'utf8'),
    ) as { bindings: Array<{ type: string; schedule?: string }> };
    expect(fn.bindings[0]).toMatchObject({ type: 'timerTrigger', schedule: '0 30 9 * * 1' });
  });
});
