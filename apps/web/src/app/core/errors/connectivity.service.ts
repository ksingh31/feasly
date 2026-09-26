import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { isPlatformBrowser } from '@angular/common';
import { DestroyRef, inject, Injectable, PLATFORM_ID, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, fromEvent, map, of, timeout } from 'rxjs';
import { ConfigService } from '../config/config.service';

/**
 * Reachability state (HRD-02): is the API actually answering?
 *
 * The app shell renders the branded offline page while `offline()` is true.
 * Detection is service-worker-free per the story's assumption: a lightweight
 * `GET /api/health` probe plus the browser's own online/offline events.
 *
 * Only network-level failures (status 0, timeout) count as offline — an HTTP
 * 500 means the API is reachable but sick, which is `/error` territory, not
 * the offline page. The probe never runs during prerender/SSR.
 *
 * The probe is skipped when it cannot be meaningful:
 * - `api.useMockApi` is true — the "API" is the in-process mock, always
 *   reachable; a down Function App must not show the offline page while the
 *   app works fine on mocks.
 * - `api.baseUrl` is empty — the startup config failed to load and the probe
 *   would hit the SWA origin's `/api/health`, which can never succeed (the
 *   API is cross-origin by architecture).
 */
@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly offlineSignal = signal(false);
  /** True while the API is unreachable — the shell shows the offline page. */
  readonly offline = this.offlineSignal.asReadonly();

  private probeInFlight = false;

  constructor() {
    if (!this.browser || typeof window === 'undefined') {
      return;
    }
    fromEvent(window, 'online')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.checkHealth());
    fromEvent(window, 'offline')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.offlineSignal.set(true));
    if (navigator.onLine === false) {
      this.offlineSignal.set(true);
    } else {
      this.checkHealth();
    }
  }

  /**
   * Re-probes `GET /api/health`; sets or clears the offline flag.
   * Safe to call repeatedly — concurrent probes are coalesced.
   */
  checkHealth(): void {
    if (!this.browser || this.probeInFlight) {
      return;
    }
    const api = this.config.get('api');
    // No meaningful probe target: mock mode has no network API to reach, and
    // an empty baseUrl means the probe would 404 against the SWA origin.
    if (api.useMockApi || !api.baseUrl) {
      return;
    }
    this.probeInFlight = true;
    const url = `${api.baseUrl}/api/health`;
    // The shared API timeout bounds the probe — a hung health check must not
    // hang offline detection (or the "Try again" button) indefinitely.
    const timeoutMs = api.timeoutMs;
    this.http
      .get(url, { responseType: 'text' })
      .pipe(
        timeout(timeoutMs),
        map(() => false),
        catchError((error: unknown) =>
          // TimeoutError (not an HttpErrorResponse) also means unreachable.
          of(error instanceof HttpErrorResponse ? error.status === 0 : true),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((isDown) => {
        this.probeInFlight = false;
        this.offlineSignal.set(isDown);
      });
  }

  /**
   * Called when an API request fails at the network layer. Re-verifies via
   * the health probe rather than trusting a single failed request.
   */
  markUnreachable(): void {
    if (!this.browser) {
      return;
    }
    this.checkHealth();
  }
}
