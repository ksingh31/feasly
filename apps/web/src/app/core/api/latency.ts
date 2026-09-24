import { map, timer } from 'rxjs';
import type { Observable } from 'rxjs';

/**
 * Simulated network latency for the mock API (FE0-003).
 *
 * Waits a random duration in [minMs, maxMs]. Built on RxJS `timer`, so the
 * wait is teardown-aware: unsubscribing cancels it — no orphaned setTimeout.
 * The window comes from ConfigService (`timings.mockLatencyMinMs/MaxMs`);
 * the real API ignores it entirely.
 */
export function simulateLatency(minMs: number, maxMs: number): Observable<void> {
  const span = Math.max(0, maxMs - minMs);
  const waitMs = minMs + Math.random() * span;
  return timer(waitMs).pipe(map(() => undefined));
}
