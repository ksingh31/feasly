/**
 * Community-stats refresh timer adapter test (neighbourhood/05).
 *
 * The adapter is thin by design; this pins its wiring: the timer run
 * invokes `communityStatsRefreshService.runRefreshCycle()` and logs
 * aggregate counts only (never PII — no community internals).
 *
 * The monthly schedule itself (`0 0 0 1 * *` NCRONTAB = 00:00 UTC on the
 * 1st of each month) is pinned by the function.json assertion below.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const runRefreshCycle = vi.fn();
const fakeApp = {
  communityStatsRefreshService: { runRefreshCycle },
};

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
}));

// Imported after the mock: the adapter binds `createComposition` lazily via
// getApp(), but the module import itself must see the mocked barrel.
import { communityStatsRefreshTimerHandler } from '../src/functions/community-stats-refresh-timer';

beforeEach(() => {
  runRefreshCycle.mockReset();
  runRefreshCycle.mockResolvedValue({
    refreshed: 212,
    skipped: 3,
    rollYear: '2025',
    refreshedAt: new Date('2026-10-01T00:00:00Z'),
    consecutiveFailures: 0,
  });
});

describe('community-stats-refresh-timer adapter', () => {
  it('runs one refresh cycle per timer invocation', async () => {
    const logs: unknown[][] = [];
    await communityStatsRefreshTimerHandler({
      log: (...args: unknown[]) => void logs.push(args),
    });

    expect(runRefreshCycle).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
  });

  it('logs aggregate counts — the ops channel line', async () => {
    const logs: unknown[][] = [];
    await communityStatsRefreshTimerHandler({
      log: (...args: unknown[]) => void logs.push(args),
    });

    const line = String(logs[0]![0]);
    expect(line).toContain('community-stats-refresh-timer:');
    expect(line).toContain('refreshed=212');
    expect(line).toContain('skipped=3');
    expect(line).toContain('roll_year=2025');
  });

  it('logs aggregate counts only — never PII', async () => {
    const logs: unknown[][] = [];
    await communityStatsRefreshTimerHandler({
      log: (...args: unknown[]) => void logs.push(args),
    });

    const line = String(logs[0]![0]);
    expect(line).not.toMatch(/@/);
    expect(line).not.toMatch(/token/i);
  });

  it('propagates a cycle failure so the host logs/retries it', async () => {
    runRefreshCycle.mockRejectedValue(new Error('Socrata unreachable: timeout'));
    await expect(
      communityStatsRefreshTimerHandler({ log: () => {} }),
    ).rejects.toThrow('Socrata unreachable');
  });

  it('function.json schedules the timer monthly (00:00 UTC on the 1st)', async () => {
    const doc = JSON.parse(
      readFileSync(
        join(__dirname, '..', 'community-stats-refresh-timer', 'function.json'),
        'utf8',
      ),
    ) as {
      bindings?: Array<{ type?: string; schedule?: string }>;
    };
    const timer = doc.bindings?.find((b) => b.type === 'timerTrigger');
    expect(timer).toBeDefined();
    // NCRONTAB: {second} {minute} {hour} {day} {month} {day-of-week}.
    // `0 0 0 1 * *` = 00:00:00 UTC on day 1 of every month (the story's
    // `0 0 1 * *` in 5-field cron).
    expect(timer!.schedule).toBe('0 0 0 1 * *');
  });
});
