/**
 * Sandbox purge timer adapter test (api-mcp/09).
 *
 * The adapter is thin by design; this pins its wiring: the timer run
 * invokes `sandboxPurgeService.runPurge()` and logs per-table aggregate
 * counts only (never PII — no emails, ids, or tokens).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runPurge = vi.fn();
const fakeApp = {
  sandboxPurgeService: { runPurge },
};

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
}));

// Imported after the mock: the adapter binds `createComposition` lazily via
// getApp(), but the module import itself must see the mocked barrel.
import { sandboxPurgeTimerHandler } from '../src/functions/sandbox-purge-timer';

beforeEach(() => {
  runPurge.mockReset();
  runPurge.mockResolvedValue({
    counts: { magicLinks: 5, analyticsEvents: 12, leads: 3, estimates: 3 },
    dryRun: false,
    cutoff: new Date('2026-08-26T00:00:00Z'),
  });
});

describe('sandbox-purge-timer adapter', () => {
  it('runs one purge cycle per timer invocation', async () => {
    const logs: unknown[][] = [];
    await sandboxPurgeTimerHandler({ log: (...args: unknown[]) => void logs.push(args) });

    expect(runPurge).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
  });

  it('logs per-table aggregate counts — the ops channel line', async () => {
    const logs: unknown[][] = [];
    await sandboxPurgeTimerHandler({ log: (...args: unknown[]) => void logs.push(args) });

    const line = String(logs[0]![0]);
    expect(line).toContain('sandbox-purge:');
    expect(line).toContain('magic_links=5');
    expect(line).toContain('analytics_events=12');
    expect(line).toContain('leads=3');
    expect(line).toContain('estimates=3');
    expect(line).toContain('mode=live');
  });

  it('logs aggregate counts only — never PII', async () => {
    const logs: unknown[][] = [];
    await sandboxPurgeTimerHandler({ log: (...args: unknown[]) => void logs.push(args) });

    const line = String(logs[0]![0]);
    // No email addresses, ids, or tokens in the log line.
    expect(line).not.toMatch(/@/);
    expect(line).not.toMatch(/token/i);
  });

  it('surfaces dry-run mode in the log line on the first run', async () => {
    runPurge.mockResolvedValue({
      counts: { magicLinks: 1, analyticsEvents: 0, leads: 0, estimates: 0 },
      dryRun: true,
      cutoff: new Date('2026-08-26T00:00:00Z'),
    });
    const logs: unknown[][] = [];
    await sandboxPurgeTimerHandler({ log: (...args: unknown[]) => void logs.push(args) });

    expect(String(logs[0]![0])).toContain('mode=dry-run');
  });
});
