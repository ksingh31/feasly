/**
 * #725 — builder-notifications timer adapter: one cycle per invocation,
 * aggregate counts only (never PII), and the #217 CYCLE FAILED contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runCycle = vi.fn();
const fakeApp = { builderNotificationsService: { runCycle } };

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
}));

import {
  builderNotificationsTimerHandler,
  runBuilderNotificationsTimer,
} from '../src/functions/builder-notifications-timer';

beforeEach(() => {
  runCycle.mockReset();
  runCycle.mockResolvedValue({ sent: 3, skipped: 1, failed: 2, digestsQueued: 4 });
});

describe('builder-notifications-timer adapter', () => {
  it('runs one cycle per invocation and logs aggregate counts only', async () => {
    const logs: unknown[][] = [];
    await builderNotificationsTimerHandler({ log: (...args: unknown[]) => void logs.push(args) });
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
    const line = String(logs[0]![0]);
    expect(line).toContain('sent=3');
    expect(line).toContain('skipped=1');
    expect(line).toContain('failed=2');
    expect(line).toContain('digestsQueued=4');
    expect(line).not.toMatch(/@/);
  });

  it('a cycle-level throw logs a sanitized CYCLE FAILED line and rethrows', async () => {
    runCycle.mockRejectedValueOnce(new Error('send to admin@elite.example failed'));
    const logs: unknown[][] = [];
    await expect(
      runBuilderNotificationsTimer(fakeApp as never, { log: (...args: unknown[]) => void logs.push(args) }),
    ).rejects.toThrow();
    const line = String(logs[0]![0]);
    expect(line).toContain('builder-notifications-timer: CYCLE FAILED');
    expect(line).not.toContain('admin@elite.example');
  });
});
