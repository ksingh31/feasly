import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  EmbedPublicConfig,
  EmbedSessionRequest,
  EmbedSessionResponse,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Builder-config client (EMB-01): resolves the public tenant config from
 * `GET /api/v1/embed/config?key=`.
 *
 * This deliberately bypasses the `API_SERVICE` mock switch — the endpoint is
 * public and unauthenticated by design (EMB-02), and the mock harness has no
 * builder configs. A failed fetch surfaces as an error so the shell can
 * show its fallback card; it never returns invented builder data.
 */
@Injectable({ providedIn: 'root' })
export class EmbedConfigService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  /** Resolve the public config for a tenant key. Errors on unknown key (404 UNKNOWN_TENANT). */
  getConfig(tenantKey: string): Observable<EmbedPublicConfig> {
    const base = this.config.get('api').baseUrl;
    const params = new HttpParams().set('key', tenantKey);
    return this.http
      .get<EmbedPublicConfig>(`${base}/api/v1/embed/config`, { params })
      .pipe(timeout(this.config.get('api').timeoutMs), catchError(toApiError));
  }

  /**
   * Exchange a one-time relay code for a session token (embed/06).
   *
   * The iframe calls this once per boot after receiving `feasly:relay`
   * from the builder snippet. The session token is held in NGXS state
   * (memory only) — never localStorage, never a cookie.
   */
  exchangeRelayCode(request: EmbedSessionRequest): Observable<EmbedSessionResponse> {
    const base = this.config.get('api').baseUrl;
    return this.http
      .post<EmbedSessionResponse>(`${base}/api/v1/embed/session`, request)
      .pipe(timeout(this.config.get('api').timeoutMs), catchError(toApiError));
  }
}
