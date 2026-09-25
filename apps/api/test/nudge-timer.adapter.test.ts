/**
 * Nudge timer adapter test (email/02).
 *
 * The adapter is thin by design; this pins its wiring: the timer run
 * invokes `nudgeService.runNudgeCycle()` and logs aggregate counts only
 * (never PII — no emails, lead ids, or tokens).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runNudgeCycle = vi.fn();
const fakeApp = {
  nudgeService: { runNudgeCycle },
};

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
}));

// Imported after the mock: the adapter binds `createComposition` lazily via
// getApp(), but the module import itself must see the mocked barrel.
import { nudgeTimerHandler } from '../src/functions/nudge-timer';

beforeEach(() => {
  runNudgeCycle.mockReset();
  runNudgeCycle.mockResolvedValue({ nudged: 3, skipped: 1 });
});

describe('nudge-timer adapter', () => {
  it('runs one nudge cycle per timer invocation', async () => {
    const logs: unknown[][] = [];
    await nudgeTimerHandler({ log: (...args: unknown[]) => void logs.push(args) });

    expect(runNudgeCycle).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
  });

  it('logs aggregate counts only — never PII', async () => {
    const logs: unknown[][] = [];
    await nudgeTimerHandler({ log: (...args: unknown[]) => void logs.push(args) });

    const line = String(logs[0]![0]);
    expect(line).toContain('nudged=3');
    expect(line).toContain('skipped=1');
    // No email addresses, lead ids, or tokens in the log line.
    expect(line).not.toMatch(/@/);
    expect(line).not.toMatch(/lead-/);
    expect(line).not.toMatch(/token/);
  });
});
