/**
 * Follow-up timer adapter (#703): one cycle per invocation, aggregate
 * counts only (never PII), and the #217 CYCLE FAILED visibility contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runFollowUpCycle = vi.fn();
const fakeApp = { followUpService: { runFollowUpCycle } };

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
}));

import { followUpTimerHandler, runFollowUpTimer } from '../src/functions/follow-up-timer';

beforeEach(() => {
  runFollowUpCycle.mockReset();
  runFollowUpCycle.mockResolvedValue({ sent: 2, skipped: 1 });
});

describe('follow-up-timer adapter', () => {
  it('runs one cycle per invocation and logs aggregate counts only', async () => {
    const logs: unknown[][] = [];
    await followUpTimerHandler({ log: (...args: unknown[]) => void logs.push(args) });
    expect(runFollowUpCycle).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
    const line = String(logs[0]![0]);
    expect(line).toContain('sent=2');
    expect(line).toContain('skipped=1');
    expect(line).not.toMatch(/@/);
  });

  it('a cycle-level throw logs a sanitized CYCLE FAILED line and rethrows', async () => {
    runFollowUpCycle.mockRejectedValueOnce(new Error('send to lead@example.com failed'));
    const logs: unknown[][] = [];
    await expect(
      runFollowUpTimer(fakeApp, { log: (...args: unknown[]) => void logs.push(args) }),
    ).rejects.toThrow();
    const line = String(logs[0]![0]);
    expect(line).toContain('follow-up-timer: CYCLE FAILED');
    expect(line).not.toContain('lead@example.com');
  });
});
