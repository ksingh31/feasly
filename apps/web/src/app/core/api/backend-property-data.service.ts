import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type { AutocompleteResponse, PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../config/config.service';
import type { PropertyDataService } from './property-data.service';
import { toApiError } from './api-error';

/**
 * Backend property data (FE1-002, extracted from HttpApiService): the
 * client's proposal for our own /api/v1 property routes. Selected by
 * `propertyData.source: 'backend'` once BE-3+ implements them; until then
 * the live City API ('live', the default) serves property data directly.
 */
@Injectable({ providedIn: 'root' })
export class BackendPropertyDataService implements PropertyDataService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get base(): string {
    return `${this.config.get('api').baseUrl}/api/v1`;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  autocomplete(query: string): Observable<AutocompleteResponse> {
    return this.call(
      this.http.post<AutocompleteResponse>(`${this.base}/properties/autocomplete`, { query }),
    );
  }

  getProperty(addressKey: string): Observable<PropertyRecord> {
    return this.call(this.http.get<PropertyRecord>(`${this.base}/properties/${addressKey}`));
  }
}
