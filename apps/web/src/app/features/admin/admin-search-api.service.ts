import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type { AdminSearchResponse } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin global search client (#537 / #538 ⌘K palette):
 * `GET /api/v1/admin/search?q=`. Session cookie auth (`withCredentials`),
 * shared API timeout, errors normalised through `toApiError`.
 */
@Injectable({ providedIn: 'root' })
export class AdminSearchApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  /** Versioned contract path — API contract, not a tunable. */
  private static readonly SEARCH_PATH = '/api/v1/admin/search';

  search(query: string): Observable<AdminSearchResponse> {
    const api = this.config.get('api');
    return this.http
      .get<AdminSearchResponse>(api.baseUrl + AdminSearchApiService.SEARCH_PATH, {
        params: new HttpParams().set('q', query),
        withCredentials: true,
      })
      .pipe(timeout(api.timeoutMs), catchError(toApiError));
  }
}
