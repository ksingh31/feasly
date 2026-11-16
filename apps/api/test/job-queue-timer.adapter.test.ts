/**
 * Job-queue timer adapter (#838): one worker run per invocation, aggregate
 * counts only (never PII), and the #217 RUN FAILED visibility contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runOnce = vi.fn();
const fakeApp = { jobQueueService: { runOnce } };

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
}));

import { jobQueueTimerHandler, runJobQueueTimer } from '../src/functions/job-queue-timer';

beforeEach(() => {
  runOnce.mockReset();
  runOnce.mockResolvedValue({ claimed: 4, done: 2, retried: 1, deadLettered: 1 });
});

describe('job-queue-timer adapter (#838)', () => {
  it('runs one batch and logs aggregate counts', async () => {
    const logs: unknown[][] = [];
    await jobQueueTimerHandler({ log: (...args: unknown[]) => void logs.push(args) });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(String(logs[0]![0])).toBe(
      'job-queue-timer: run complete (claimed=4 done=2 retried=1 dead=1)',
    );
  });

  it('a run-level throw logs a sanitized RUN FAILED line and rethrows', async () => {
    runOnce.mockRejectedValueOnce(new Error('claim failed for sam@example.com'));
    const logs: unknown[][] = [];
    await expect(
      runJobQueueTimer(fakeApp, { log: (...args: unknown[]) => void logs.push(args) }),
    ).rejects.toThrow('claim failed');
    const line = String(logs[0]![0]);
    expect(line).toContain('job-queue-timer: RUN FAILED');
    expect(line).not.toContain('sam@example.com');
  });
});
