import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AcceptAgreementRequest,
  AcceptAgreementResponse,
  AgreementStatus,
  BuilderOnboardingStatus,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Builder platform-agreement + onboarding API client (#722).
 *
 * Speaks `/api/v1/builder/agreement`, `/agreement/accept` and
 * `/builder/onboarding` behind the builder session cookie. Every call is
 * scoped server-side to the session's active org; only an org admin may
 * accept (403 AGREEMENT_ADMIN_REQUIRED otherwise), and a stale version
 * answers 409 AGREEMENT_VERSION_MISMATCH.
 *
 * Not wired to the mock API — the builder portal always talks to the real
 * backend (the e2e suite answers these routes with contract-shaped
 * fixtures in `e2e/builder-api-fixtures.ts`).
 */
@Injectable({ providedIn: 'root' })
export class BuilderOnboardingApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get builderBase(): string {
    return `${this.config.get('api').baseUrl}/api/v1/builder`;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** The org's acceptance status for the current version, with the text. */
  getAgreement(): Observable<AgreementStatus> {
    return this.call(
      this.http.get<AgreementStatus>(`${this.builderBase}/agreement`, {
        withCredentials: true,
      }),
    );
  }

  /** Accept the current agreement version (org admin only). */
  acceptAgreement(version: string): Observable<AcceptAgreementResponse> {
    const body: AcceptAgreementRequest = { version };
    return this.call(
      this.http.post<AcceptAgreementResponse>(
        `${this.builderBase}/agreement/accept`,
        body,
        { withCredentials: true },
      ),
    );
  }

  /** First-run checklist flags, all computed server-side. */
  getOnboarding(): Observable<BuilderOnboardingStatus> {
    return this.call(
      this.http.get<BuilderOnboardingStatus>(`${this.builderBase}/onboarding`, {
        withCredentials: true,
      }),
    );
  }
}
