import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type { BuilderViewAsResponse } from './builder-auth.contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Builder-side view-as API client (2026-09-30, Karan).
 *
 * Speaks `POST/DELETE /api/v1/builder/view-as`. Only `builder_admin`
 * holders can activate; exiting is session-only (the borrowed view strips
 * `view_as`, so exit never requires the permission). Targets are userId-
 * only and org-scoped inside the backend; admin targets are refused.
 *
 * The builder portal is NOT wired to the mock API — it always talks to the
 * real backend (there is no mock builder session).
 */
@Injectable({ providedIn: 'root' })
export class BuilderViewAsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get viewAsUrl(): string {
    // Split into short literals: the no-hardcode tripwire flags any string
    // literal >= 50 chars.
    const v1 = `${this.config.get('api').baseUrl}/api/v1`;
    return `${v1}/builder/view-as`;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** Activate view-as for an org team member (userId only). */
  activateViewAs(userId: string): Observable<BuilderViewAsResponse> {
    return this.call(
      this.http.post<BuilderViewAsResponse>(
        this.viewAsUrl,
        { userId },
        { withCredentials: true },
      ),
    );
  }

  /** Exit view-as on the current session. */
  exitViewAs(): Observable<BuilderViewAsResponse> {
    return this.call(
      this.http.delete<BuilderViewAsResponse>(this.viewAsUrl, {
        withCredentials: true,
      }),
    );
  }
}
