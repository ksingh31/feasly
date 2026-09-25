import { inject, Injectable } from '@angular/core';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';
import type { ApiError, AutocompleteResponse, PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../config/config.service';
import type { PropertyDataService } from './property-data.service';
import { simulateLatency } from './latency';
import { mockPropertyFor, mockSuggestions } from './mock-data';

/**
 * Non-Calgary signals mirrored from the backend's coverage heuristic
 * (apps/api/src/lib/coverage.ts): explicit city tokens and non-T2/T3
 * Canadian postal codes. Kept in sync by the reno/05 contract tests.
 */
const NON_CALGARY_CITY_TOKENS = [
  'edmonton', 'toronto', 'vancouver', 'ottawa', 'montreal', 'winnipeg',
  'halifax', 'victoria', 'regina', 'saskatoon', 'kelowna', 'red deer',
  'lethbridge', 'mississauga', 'brampton', 'surrey', 'burnaby',
];
const POSTAL_CODE = /\b([ABCEGHJ-NPR-TV-Z])(\d)([ABCEGHJ-NPR-TV-Z])\s?(\d)([ABCEGHJ-NPR-TV-Z])(\d)\b/i;
const CALGARY_FSA = /^T[23]/i;

/** Reno/05: mock-mode mirror of the backend coverage heuristic. */
function isOutOfCoverage(query: string): boolean {
  const lowered = query.trim().toLowerCase();
  if (!lowered) return false;
  const postal = lowered.match(POSTAL_CODE);
  if (postal) return !CALGARY_FSA.test(postal[1] + postal[2]);
  if (/\bcalgary\b/i.test(lowered)) return false;
  return NON_CALGARY_CITY_TOKENS.some((city) =>
    new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lowered),
  );
}

const OUT_OF_COVERAGE_CODE = 'OUT_OF_COVERAGE';
const ADDRESS_NOT_FOUND_CODE = 'ADDRESS_NOT_FOUND';

/**
 * Mock property data (FE0-003, extracted FE1-002): the fixture-backed
 * autocomplete + property records, kept as the offline fallback behind
 * `propertyData.source: 'mock'`. Everything here is obviously fake — see
 * mock-data.ts, the one allowlisted home for fixture literals.
 */
@Injectable({ providedIn: 'root' })
export class MockPropertyDataService implements PropertyDataService {
  private readonly config = inject(ConfigService);

  /** Simulates one network round trip using the configured mock latency. */
  private roundTrip<T>(value: T): Observable<T> {
    const timings = this.config.get('timings');
    return simulateLatency(timings.mockLatencyMinMs, timings.mockLatencyMaxMs).pipe(
      map(() => value),
    );
  }

  private roundTripError(error: ApiError): Observable<never> {
    const timings = this.config.get('timings');
    return simulateLatency(timings.mockLatencyMinMs, timings.mockLatencyMaxMs).pipe(
      map(() => {
        throw error;
      }),
    );
  }

  autocomplete(query: string): Observable<AutocompleteResponse> {
    const q = query.trim().toLowerCase();
    // Reno/05: mock-mode mirror of the backend — explicit out-of-coverage
    // queries fail with OUT_OF_COVERAGE instead of an empty suggestion list.
    if (isOutOfCoverage(query)) {
      return this.roundTripError(this.outOfCoverageError());
    }
    const suggestions =
      q.length < 3
        ? []
        : mockSuggestions()
            .filter((s) => s.address.toLowerCase().includes(q))
            .slice(0, 6);
    return this.roundTrip({ suggestions });
  }

  getProperty(addressKey: string): Observable<PropertyRecord> {
    // Reno/05: a non-Calgary address key can never resolve in mock mode.
    if (isOutOfCoverage(addressKey)) {
      return this.roundTripError(this.outOfCoverageError());
    }
    const property = mockPropertyFor(addressKey);
    if (!property) {
      return this.roundTripError({
        code: ADDRESS_NOT_FOUND_CODE,
        message: this.config.get('copy').search.noResults,
        retryable: false,
      });
    }
    return this.roundTrip(property);
  }

  /** Reno/05: story-pinned Calgary-only copy, from config (never hardcoded). */
  private outOfCoverageError(): ApiError {
    const search = this.config.get('copy').search;
    return {
      code: OUT_OF_COVERAGE_CODE,
      message: `${search.outOfCoverageHeading} ${search.outOfCoverageBody}`,
      retryable: false,
    };
  }
}
