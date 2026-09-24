import { inject, Injectable } from '@angular/core';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';
import type { ApiError, AutocompleteResponse, PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../config/config.service';
import type { PropertyDataService } from './property-data.service';
import { simulateLatency } from './latency';
import { mockPropertyFor, mockSuggestions } from './mock-data';

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
    const suggestions =
      q.length < 3
        ? []
        : mockSuggestions()
            .filter((s) => s.address.toLowerCase().includes(q))
            .slice(0, 6);
    return this.roundTrip({ suggestions });
  }

  getProperty(addressKey: string): Observable<PropertyRecord> {
    const property = mockPropertyFor(addressKey);
    if (!property) {
      return this.roundTripError({
        code: 'not_found',
        message: 'No City record for that address yet.',
        retryable: false,
      });
    }
    return this.roundTrip(property);
  }
}
