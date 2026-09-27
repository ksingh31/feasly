/**
 * Nudge timer adapter test (email/02).
 *
 * The adapter is thin by design; this pins its wiring: the timer run
 * invokes `nudgeService.runNudgeCycle()` and logs aggregate counts only
 * (never PII — no emails, lead ids, or tokens).
 *
 * Also pins the #217/#218 failure-visibility contract: a cycle-level
 * throw logs a structured, sanitized `CYCLE FAILED` line and rethrows so
 * the host records the invocation failure.
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
import { nudgeTimerHandler, runNudgeTimer } from '../src/functions/nudge-timer';

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

describe('nudge-timer failure visibility (#217 pattern)', () => {
  it('a cycle-level throw logs a structured CYCLE FAILED line and rethrows', async () => {
    runNudgeCycle.mockRejectedValueOnce(new Error('DB down: connection refused'));
    const logs: unknown[][] = [];
    await expect(
      runNudgeTimer(fakeApp, {
        log: (...args: unknown[]) => void logs.push(args),
      }),
    ).rejects.toThrow('DB down');
    expect(logs).toHaveLength(1);
    const line = String(logs[0]![0]);
    expect(line).toContain('nudge-timer: CYCLE FAILED');
    expect(line).toContain('DB down');
  });

  it('the CYCLE FAILED line sanitizes PII out of the error', async () => {
    runNudgeCycle.mockRejectedValueOnce(
      new Error('send to lead@example.com failed for token abc123'),
    );
    const logs: unknown[][] = [];
    await expect(
      runNudgeTimer(fakeApp, {
        log: (...args: unknown[]) => void logs.push(args),
      }),
    ).rejects.toThrow();
    const line = String(logs[0]![0]);
    expect(line).toContain('nudge-timer: CYCLE FAILED');
    expect(line).not.toContain('lead@example.com');
  });

  it('a cycle-level throw via the handler propagates (host records the failure)', async () => {
    runNudgeCycle.mockRejectedValueOnce(new Error('boom'));
    const logs: unknown[][] = [];
    await expect(
      nudgeTimerHandler({ log: (...args: unknown[]) => void logs.push(args) }),
    ).rejects.toThrow('boom');
    expect(String(logs[0]![0])).toContain('CYCLE FAILED');
  });
});
