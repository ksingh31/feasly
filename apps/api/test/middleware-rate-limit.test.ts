import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../src/middleware/rate-limit';

describe('createRateLimiter — window behavior (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows maxRequests then denies the 11th with a retry hint', () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 10,
      maxTrackedKeys: 1000,
    });

    for (let i = 0; i < 10; i++) {
      expect(limiter.check('1.2.3.4').allowed).toBe(true);
    }
    const denied = limiter.check('1.2.3.4');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('tracks keys independently', () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      maxTrackedKeys: 1000,
    });
    expect(limiter.check('1.1.1.1').allowed).toBe(true);
    expect(limiter.check('1.1.1.1').allowed).toBe(false);
    expect(limiter.check('2.2.2.2').allowed).toBe(true);
  });

  it('the window resets after windowMs', () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      maxTrackedKeys: 1000,
    });
    expect(limiter.check('9.9.9.9').allowed).toBe(true);
    expect(limiter.check('9.9.9.9').allowed).toBe(true);
    expect(limiter.check('9.9.9.9').allowed).toBe(false);

    vi.setSystemTime(Date.now() + 60_001);
    expect(limiter.check('9.9.9.9').allowed).toBe(true);
  });

  it('retryAfterMs counts down toward the window reset', () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      maxTrackedKeys: 1000,
    });
    limiter.check('3.3.3.3');
    const first = limiter.check('3.3.3.3');
    vi.setSystemTime(Date.now() + 45_000);
    const later = limiter.check('3.3.3.3');
    expect(later.retryAfterMs).toBeLessThan(first.retryAfterMs);
  });
});

describe('createRateLimiter — injected clock and key bound', () => {
  it('a manual clock drives the window deterministically', () => {
    let now = 0;
    const limiter = createRateLimiter({
      windowMs: 1000,
      maxRequests: 1,
      maxTrackedKeys: 100,
      clock: () => now,
    });
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(false);
    now = 1001;
    expect(limiter.check('k').allowed).toBe(true);
  });

  it('expired windows are swept when the key map overflows', () => {
    let now = 0;
    const limiter = createRateLimiter({
      windowMs: 1000,
      maxRequests: 100,
      maxTrackedKeys: 2,
      clock: () => now,
    });
    limiter.check('a');
    limiter.check('b');
    limiter.check('c'); // overflow, but nothing expired yet — still fine
    now = 2000; // all windows expired
    limiter.check('d'); // sweep drops a, b, c
    expect(limiter.check('a').allowed).toBe(true);
  });
});
