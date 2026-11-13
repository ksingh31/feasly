/**
 * #469: a production build never fails solely because data.calgary.ca is
 * unreachable; staleness is surfaced as a warning instead.
 */
import { describe, expect, it, vi } from 'vitest';
import { reportRefreshFailure, resolveRefreshFailure } from './snapshot-fallback.js';

const base = {
  label: 'build-community-data',
  fileName: 'community-aggregates.json',
  maxAgeDays: 30,
  error: new TypeError('fetch failed'),
  scriptPath: 'apps/web/scripts/build-community-data.ts',
};

function fakeLog() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('resolveRefreshFailure', () => {
  it('continues quietly with a fresh snapshot', () => {
    const outcome = resolveRefreshFailure({ ...base, age: 3 });
    expect(outcome).toMatchObject({ action: 'continue', level: 'info' });
    expect(outcome.message).toContain('fetch failed');
  });

  it('continues with a warning when the snapshot is stale (network error alone never fails)', () => {
    const outcome = resolveRefreshFailure({ ...base, age: 45.2 });
    expect(outcome).toMatchObject({ action: 'continue', level: 'warning' });
    expect(outcome.message).toContain('STALE community-aggregates.json');
    expect(outcome.message).toContain('45.2 days old');
    expect(outcome.message).toContain('tsx apps/web/scripts/build-community-data.ts --force');
  });

  it('fails when the snapshot is missing or unreadable', () => {
    const outcome = resolveRefreshFailure({ ...base, age: null });
    expect(outcome.action).toBe('fail');
    expect(outcome.message).toContain('no readable community-aggregates.json');
  });

  it('handles non-Error throwables', () => {
    expect(resolveRefreshFailure({ ...base, error: 'boom', age: 40 }).message).toContain('boom');
  });
});

describe('reportRefreshFailure', () => {
  it('returns 0 and emits a GitHub Actions warning annotation for a stale snapshot in CI', () => {
    const log = fakeLog();
    const code = reportRefreshFailure(resolveRefreshFailure({ ...base, age: 40 }), { GITHUB_ACTIONS: 'true' }, log);
    expect(code).toBe(0);
    expect(log.log).toHaveBeenCalledWith(expect.stringMatching(/^::warning title=Stale community data snapshot::/));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('warns without an annotation outside CI', () => {
    const log = fakeLog();
    expect(reportRefreshFailure(resolveRefreshFailure({ ...base, age: 40 }), {}, log)).toBe(0);
    expect(log.log).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('returns 0 without an annotation for a fresh snapshot', () => {
    const log = fakeLog();
    expect(reportRefreshFailure(resolveRefreshFailure({ ...base, age: 1 }), { GITHUB_ACTIONS: 'true' }, log)).toBe(0);
    expect(log.log).not.toHaveBeenCalled();
  });

  it('returns 1 and logs an error when no snapshot is available', () => {
    const log = fakeLog();
    expect(reportRefreshFailure(resolveRefreshFailure({ ...base, age: null }), {}, log)).toBe(1);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
