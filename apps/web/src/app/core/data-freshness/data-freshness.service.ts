import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';
import type { CityDataFreshnessResponse } from '@feasly/contracts';
import { API_SERVICE } from '../api/api.service';
import { ConfigService } from '../config/config.service';

/** Normalized freshness answer: each field null when unknown. */
export interface DataFreshness {
  readonly refreshedMonth: string | null;
  readonly rollYear: number | null;
}

const UNKNOWN: DataFreshness = { refreshedMonth: null, rollYear: null };

/**
 * Shared City-data freshness (#513): GET /api/v1/city-data/freshness, called
 * at most once per app session and shared by the landing trust strip and the
 * property card so both tell the same freshness story.
 *
 * Mock-aware: while the mock property harness serves the data
 * (`propertyData.source === 'mock'`) it never calls the endpoint — sample
 * values must never claim a live City check. A failed request resolves to
 * "unknown" (both null) and the surfaces fall back to honest generic copy;
 * a failure is not cached, so the next `load()` tries again.
 */
@Injectable({ providedIn: 'root' })
export class DataFreshnessService {
  private readonly api = inject(API_SERVICE);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly state = signal<DataFreshness>(UNKNOWN);
  private requested = false;

  /** Current freshness (both null until — or unless — the API answers). */
  readonly freshness = this.state.asReadonly();

  /** Fire the one request (idempotent; no-op on the mock property path). */
  load(): void {
    if (this.requested || this.config.get('propertyData').source === 'mock') return;
    this.requested = true;
    this.api
      .getCityDataFreshness()
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => {
          // A failure is not cached: the next landing / card mount retries.
          this.requested = false;
          return of<CityDataFreshnessResponse>(UNKNOWN);
        }),
      )
      .subscribe((res) =>
        this.state.set({
          refreshedMonth: res.refreshedMonth ?? null,
          rollYear: res.rollYear ?? null,
        }),
      );
  }
}
