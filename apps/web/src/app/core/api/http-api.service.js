import { __decorate } from "tslib";
import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, throwError, timeout } from 'rxjs';
import { ConfigService } from '../config/config.service';
/**
 * Maps an HTTP failure onto the contract ApiError envelope.
 * 5xx and network failures (status 0) are retryable; anything else isn't.
 */
function toApiError(error) {
    if (error instanceof HttpErrorResponse) {
        const body = error.error;
        return throwError(() => {
            const code = typeof body?.code === 'string' ? body.code : `http_${error.status}`;
            const message = typeof body?.message === 'string' && body.message.length > 0
                ? body.message
                : 'Request failed. Please try again.';
            const retryable = error.status === 0 || error.status >= HttpStatusCode.InternalServerError;
            return { code, message, retryable };
        });
    }
    return throwError(() => ({ code: 'unknown', message: 'Request failed. Please try again.', retryable: false }));
}
/**
 * Real backend client (FE0-003): speaks the versioned `/api/v1` routes with
 * the FE0-001 contract types. Selected by `provideApi()` when
 * `api.useMockApi` is false — flipping that flag is the only change needed
 * to point at the live backend.
 *
 * Route shapes here are the client's proposal; the backend (BE-3+) implements
 * the same contract DTOs, so any route rename is a paired change.
 */
let HttpApiService = class HttpApiService {
    http = inject(HttpClient);
    config = inject(ConfigService);
    get base() {
        return `${this.config.get('api').baseUrl}/api/v1`;
    }
    call(request) {
        const timeoutMs = this.config.get('api').timeoutMs;
        return request.pipe(timeout(timeoutMs), catchError(toApiError));
    }
    autocomplete(query) {
        return this.call(this.http.post(`${this.base}/properties/autocomplete`, { query }));
    }
    getProperty(addressKey) {
        return this.call(this.http.get(`${this.base}/properties/${addressKey}`));
    }
    getPreviewEstimate(request) {
        return this.call(this.http.post(`${this.base}/estimates/preview`, request));
    }
    getEstimate(request) {
        return this.call(this.http.post(`${this.base}/estimates`, request));
    }
    submitLead(request) {
        return this.call(this.http.post(`${this.base}/leads`, request));
    }
    verifyMagicLink(token) {
        const params = new HttpParams().set('token', token);
        return this.call(this.http.get(`${this.base}/magic-link/verify`, { params }));
    }
    reissueMagicLink(request) {
        return this.call(this.http.post(`${this.base}/magic-link/reissue`, request));
    }
    getReport(reportToken) {
        return this.call(this.http.get(`${this.base}/reports/${reportToken}`));
    }
    reviseTier(reportToken, request) {
        return this.call(this.http.post(`${this.base}/reports/${reportToken}/revisions`, request));
    }
    requestCallback(request) {
        return this.call(this.http.post(`${this.base}/callbacks`, request));
    }
    shareWithPartner(request) {
        return this.call(this.http.post(`${this.base}/shares`, request));
    }
    trackEvent(event) {
        return this.call(this.http.post(`${this.base}/events`, event));
    }
};
HttpApiService = __decorate([
    Injectable({ providedIn: 'root' })
], HttpApiService);
export { HttpApiService };
