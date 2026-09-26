import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type { AutocompleteResponse, PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../config/config.service';
import type { PropertyDataService } from './property-data.service';
import { toApiError } from './api-error';

/**
 * Backend property data (FE1-002, extracted from HttpApiService): our own
 * /api/v1 property routes. Selected by `propertyData.source: 'backend'`;
 * the live City API ('live', the default) serves property data directly
 * until then. Route shapes mirror the backend functions exactly:
 * GET /api/v1/properties/autocomplete?q=… and
 * GET /api/v1/properties/lookup?addressKey=….
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
    const params = new HttpParams().set('q', query);
    return this.call(
      this.http.get<AutocompleteResponse>(`${this.base}/properties/autocomplete`, { params }),
    );
  }

  getProperty(addressKey: string): Observable<PropertyRecord> {
    const params = new HttpParams().set('addressKey', addressKey);
    return this.call(
      this.http.get<PropertyRecord>(`${this.base}/properties/lookup`, { params }),
    );
  }
}
