/**
 * Neighbourhood data refresh timer adapter (#773): each tick calls
 * `runDue()` once and logs counts only. The timer ticks daily; the monthly
 * schedule is config (NEIGHBOURHOOD_REFRESH_DAY_OF_MONTH).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runDue = vi.fn();
vi.mock('../src/index', () => ({
  createComposition: () => ({ neighbourhoodRefreshService: { runDue } }),
}));

import { neighbourhoodDataRefreshTimerHandler } from '../src/functions/neighbourhood-data-refresh-timer';

beforeEach(() => {
  runDue.mockReset();
  runDue.mockResolvedValue({
    trigger: 'timer',
    results: [
      { provider: 'school-directory', outcome: 'ok', rowsChanged: 3 },
      { provider: 'amenities', outcome: 'failed', rowsChanged: 0 },
    ],
  });
});

describe('neighbourhood-data-refresh-timer adapter (#773)', () => {
  it('runs due providers once per tick and logs counts only', async () => {
    const logs: unknown[][] = [];
    await neighbourhoodDataRefreshTimerHandler({ log: (...args: unknown[]) => void logs.push(args) });
    expect(runDue).toHaveBeenCalledTimes(1);
    expect(String(logs[0]![0])).toBe(
      'neighbourhood-data-refresh-timer: tick complete (ran=2 school-directory=ok:3 amenities=failed:0)',
    );
  });

  it('function.json ticks daily (monthly cadence lives in config)', () => {
    const fj = JSON.parse(
      readFileSync(join(__dirname, '..', 'neighbourhood-data-refresh-timer', 'function.json'), 'utf8'),
    ) as { bindings: Array<{ type: string; schedule: string }> };
    expect(fj.bindings[0]).toMatchObject({ type: 'timerTrigger', schedule: '0 0 7 * * *' });
  });
});
