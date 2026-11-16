/**
 * Single-flight (#756): concurrent callers for one key share one call;
 * the entry clears on settle and failures are not memoized.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSingleFlight } from '../src/lib/single-flight';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('single-flight (#756)', () => {
  it('runs fn once for concurrent callers of the same key', async () => {
    const flights = createSingleFlight<number>();
    const gate = deferred<number>();
    const fn = vi.fn(() => gate.promise);
    const a = flights.run('k', fn);
    const b = flights.run('k', fn);
    expect(a.joined).toBe(false);
    expect(b.joined).toBe(true);
    expect(flights.size()).toBe(1);
    gate.resolve(7);
    await expect(Promise.all([a.promise, b.promise])).resolves.toEqual([7, 7]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(flights.size()).toBe(0);
  });

  it('keeps different keys independent', async () => {
    const flights = createSingleFlight<string>();
    const fn = vi.fn(async () => 'v');
    await Promise.all([flights.run('a', fn).promise, flights.run('b', fn).promise]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('shares a failure with joiners, then lets the next call retry', async () => {
    const flights = createSingleFlight<number>();
    const gate = deferred<number>();
    const a = flights.run('k', () => gate.promise);
    const b = flights.run('k', () => Promise.resolve(1));
    gate.reject(new Error('boom'));
    await expect(a.promise).rejects.toThrow('boom');
    await expect(b.promise).rejects.toThrow('boom');
    expect(flights.size()).toBe(0);
    await expect(flights.run('k', async () => 2).promise).resolves.toBe(2);
  });
});
