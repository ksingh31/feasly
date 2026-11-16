/**
 * Zoning watch timer adapter (#757): one runCheck per invocation, aggregate
 * flags only in the log; a cycle failure propagates to the Functions host.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runCheck = vi.fn();
vi.mock('../src/index', () => ({
  createComposition: () => ({ zoningWatchService: { runCheck } }),
}));

import { zoningWatchTimerHandler } from '../src/functions/zoning-watch-timer';

beforeEach(() => {
  runCheck.mockReset();
  runCheck.mockResolvedValue({
    skipped: false,
    datasetChanged: true,
    bylawChanged: false,
    unknownDistrictCodes: ['H-GO2'],
    cacheEntriesRefreshed: 4,
    issue: 'created',
    stale: true,
  });
});

describe('zoning-watch-timer adapter', () => {
  it('runs one check and logs the outcome flags', async () => {
    const log = vi.fn();
    await zoningWatchTimerHandler({ log });
    expect(runCheck).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain('zoning-watch-timer:');
    expect(line).toContain('dataset_changed=true');
    expect(line).toContain('unknown_codes=1');
    expect(line).toContain('issue=created');
  });

  it('propagates a cycle failure to the host', async () => {
    runCheck.mockRejectedValueOnce(new Error('db down'));
    await expect(zoningWatchTimerHandler({ log: () => {} })).rejects.toThrow('db down');
  });
});
