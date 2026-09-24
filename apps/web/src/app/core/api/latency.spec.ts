import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { simulateLatency } from './latency';

describe('simulateLatency', () => {
  it('waits within the configured window', async () => {
    const start = Date.now();
    await firstValueFrom(simulateLatency(20, 40));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(15); // slack for timer precision
    expect(elapsed).toBeLessThan(200);
  });

  it('treats an inverted window as zero wait', async () => {
    const start = Date.now();
    await firstValueFrom(simulateLatency(40, 20));
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('cancels the wait on unsubscribe (no orphaned timers)', async () => {
    let emitted = false;
    const sub = simulateLatency(40, 40).subscribe(() => {
      emitted = true;
    });
    sub.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(emitted).toBe(false);
  });
});
