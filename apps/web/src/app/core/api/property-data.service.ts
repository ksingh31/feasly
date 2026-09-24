import { inject, InjectionToken, Injector } from '@angular/core';
import type { Provider } from '@angular/core';
import type { Observable } from 'rxjs';
import type { AutocompleteResponse, PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../config/config.service';
import { BackendPropertyDataService } from './backend-property-data.service';
import { CalgaryAssessmentService } from './calgary-assessment.service';
import { MockPropertyDataService } from './mock-property-data.service';

/**
 * Property-data seam (FE1-002): address autocomplete + City property
 * records, independent from the estimate/lead/magic-link contracts.
 *
 * Components keep injecting {@link API_SERVICE} — `MockApiService` and
 * `HttpApiService` delegate their two property methods here, so the property
 * backend switches without touching any component. `api.useMockApi` still
 * selects the mock vs real backend for everything else.
 */
export interface PropertyDataService {
  /** Address autocomplete. Short queries resolve to zero suggestions. */
  autocomplete(query: string): Observable<AutocompleteResponse>;
  /** City property record for an address key. Errors `not_found` when unknown. */
  getProperty(addressKey: string): Observable<PropertyRecord>;
}

/** DI token for the PropertyDataService. Inject this, never a concrete class. */
export const PROPERTY_DATA_SERVICE = new InjectionToken<PropertyDataService>(
  'feasly.property-data',
);

/**
 * Wires the PropertyDataService implementation from config:
 * `propertyData.source` selects the live City of Calgary Socrata API
 * ('live', the dev default), the FE0-003 fixture harness ('mock'), or our
 * own /api/v1 property routes ('backend', once BE-3+ implements them).
 * Call once in app.config.ts, before `provideApi()`.
 */
export function providePropertyData(): Provider {
  return {
    provide: PROPERTY_DATA_SERVICE,
    // The implementation is chosen per CALL, not when this factory runs.
    // The factory can execute before ConfigService.load() finishes: NGXS v22
    // instantiates states inside an *environment* initializer, which Angular
    // runs before APP_INITIALIZERs (ReportState injects API_SERVICE, which
    // pulls PROPERTY_DATA_SERVICE in). An eager choice froze the compiled
    // default ('live'), so a served `propertyData.source: 'mock'` was silently
    // ignored and the app always hit the City API (found by browser QA
    // 2026-09-24). Calls only happen after bootstrap, on user interaction, so
    // resolving then honors the loaded config — including config reloads.
    useFactory: () => new LazyPropertyDataService(),
  };
}

/** Defers the property-data implementation choice to call time (see above). */
class LazyPropertyDataService implements PropertyDataService {
  private readonly injector = inject(Injector);

  private resolve(): PropertyDataService {
    const source = this.injector.get(ConfigService).get('propertyData').source;
    switch (source) {
      case 'mock':
        return this.injector.get(MockPropertyDataService);
      case 'backend':
        return this.injector.get(BackendPropertyDataService);
      default:
        return this.injector.get(CalgaryAssessmentService);
    }
  }

  autocomplete(query: string): Observable<AutocompleteResponse> {
    return this.resolve().autocomplete(query);
  }

  getProperty(addressKey: string): Observable<PropertyRecord> {
    return this.resolve().getProperty(addressKey);
  }
}
