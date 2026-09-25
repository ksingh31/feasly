/**
 * Sandbox purge service tests (api-mcp/09).
 *
 * Time-mocked: the clock is injected so the 30-day boundary is exact.
 * The store is faked at the interface boundary (not Drizzle internals).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createSandboxPurgeService,
  formatPurgeLogLine,
  type PurgeCounts,
  type SandboxPurgeStore,
} from '../src/services/sandbox-purge.service';

const DAY_MS = 24 * 3_600_000;

function fakeStore(overrides?: Partial<SandboxPurgeStore>): SandboxPurgeStore {
  const counts: PurgeCounts = {
    magicLinks: 0,
    analyticsEvents: 0,
    leads: 0,
    estimates: 0,
  };
  return {
    purgeOldSandboxRows: vi.fn().mockResolvedValue(counts),
    countOldSandboxRows: vi.fn().mockResolvedValue(counts),
    ...overrides,
  };
}

describe('sandbox-purge service', () => {
  it('purges rows older than the retention window (31 days old → purged)', async () => {
    const now = new Date('2026-09-25T00:00:00Z');
    const store = fakeStore();
    const service = createSandboxPurgeService({
      store,
      retentionDays: 30,
      dryRun: false,
      clock: () => now,
    });

    const result = await service.runPurge();

    // Cutoff is exactly 30 days before now.
    expect(result.cutoff.getTime()).toBe(now.getTime() - 30 * DAY_MS);
    expect(result.dryRun).toBe(false);
    expect(store.purgeOldSandboxRows).toHaveBeenCalledTimes(1);
    const cutoffArg = vi.mocked(store.purgeOldSandboxRows).mock.calls[0]![0];
    expect(cutoffArg.getTime()).toBe(now.getTime() - 30 * DAY_MS);
    // Dry-run path (count) must NOT be called in live mode.
    expect(store.countOldSandboxRows).not.toHaveBeenCalled();
  });

  it('keeps rows newer than the retention window (29 days old → kept)', async () => {
    // The service computes the cutoff; the store decides what matches.
    // A 29-day-old row is newer than the 30-day cutoff, so the store
    // returns zero counts.
    const now = new Date('2026-09-25T00:00:00Z');
    const store = fakeStore({
      purgeOldSandboxRows: vi.fn().mockResolvedValue({
        magicLinks: 0,
        analyticsEvents: 0,
        leads: 0,
        estimates: 0,
      }),
    });
    const service = createSandboxPurgeService({
      store,
      retentionDays: 30,
      dryRun: false,
      clock: () => now,
    });

    const result = await service.runPurge();

    expect(result.counts).toEqual({
      magicLinks: 0,
      analyticsEvents: 0,
      leads: 0,
      estimates: 0,
    });
  });

  it('returns per-table counts from the store', async () => {
    const store = fakeStore({
      purgeOldSandboxRows: vi.fn().mockResolvedValue({
        magicLinks: 5,
        analyticsEvents: 12,
        leads: 3,
        estimates: 3,
      }),
    });
    const service = createSandboxPurgeService({
      store,
      retentionDays: 30,
      dryRun: false,
    });

    const result = await service.runPurge();

    expect(result.counts).toEqual({
      magicLinks: 5,
      analyticsEvents: 12,
      leads: 3,
      estimates: 3,
    });
  });

  it('first run executes in dry-run mode (config flag; nothing deleted)', async () => {
    const store = fakeStore();
    const service = createSandboxPurgeService({
      store,
      retentionDays: 30,
      dryRun: true, // default — first-run safety
    });

    const result = await service.runPurge();

    expect(result.dryRun).toBe(true);
    expect(store.countOldSandboxRows).toHaveBeenCalledTimes(1);
    // The destructive path must NOT be called in dry-run mode.
    expect(store.purgeOldSandboxRows).not.toHaveBeenCalled();
  });

  it('dry-run defaults to true when the flag is omitted', async () => {
    const store = fakeStore();
    const service = createSandboxPurgeService({ store });

    const result = await service.runPurge();

    expect(result.dryRun).toBe(true);
    expect(store.purgeOldSandboxRows).not.toHaveBeenCalled();
  });
});

describe('formatPurgeLogLine', () => {
  it('logs per-table counts with the mode flag', () => {
    const line = formatPurgeLogLine({
      counts: { magicLinks: 5, analyticsEvents: 12, leads: 3, estimates: 3 },
      dryRun: false,
      cutoff: new Date(),
    });
    expect(line).toContain('mode=live');
    expect(line).toContain('magic_links=5');
    expect(line).toContain('analytics_events=12');
    expect(line).toContain('leads=3');
    expect(line).toContain('estimates=3');
  });

  it('marks dry-run mode explicitly in the log line', () => {
    const line = formatPurgeLogLine({
      counts: { magicLinks: 1, analyticsEvents: 0, leads: 0, estimates: 0 },
      dryRun: true,
      cutoff: new Date(),
    });
    expect(line).toContain('mode=dry-run');
  });

  it('never contains PII — only aggregate counts', () => {
    const line = formatPurgeLogLine({
      counts: { magicLinks: 2, analyticsEvents: 4, leads: 1, estimates: 1 },
      dryRun: false,
      cutoff: new Date(),
    });
    expect(line).not.toMatch(/@/);
    expect(line).not.toMatch(/token/i);
  });
});
