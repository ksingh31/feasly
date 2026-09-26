import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { ConfigService } from '../config/config.service';

/**
 * True when the request targets the API. Compares against `baseUrl + '/'`
 * (not a bare `startsWith(baseUrl)`) so a lookalike host such as
 * `<baseUrl>.evil.example` never matches.
 */
function isApiRequest(url: string, baseUrl: string): boolean {
  if (!baseUrl) {
    return false;
  }
  const prefix = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return url === baseUrl || url.startsWith(prefix);
}

/**
 * Cross-origin credential flow (ADM-10): the SWA Free SKU has no linked
 * backend, so the web app calls the Function App at `api.baseUrl` directly.
 * Every request to that base URL carries `withCredentials`, which lets the
 * `feasly_admin_session` HttpOnly cookie (`SameSite=None; Secure`) flow —
 * without it the admin session would never authenticate cross-origin.
 *
 * Scoped strictly to the configured API base URL: third-party calls (City
 * of Calgary Socrata, the config JSON fetch) never receive credentials.
 * When `api.baseUrl` is empty (mock mode / compiled default) this is a
 * no-op — relative `/api/v1/...` URLs are same-origin, where the browser
 * sends cookies regardless.
 */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) => {
  const baseUrl = inject(ConfigService).get('api').baseUrl;
  if (isApiRequest(req.url, baseUrl)) {
    req = req.clone({ withCredentials: true });
  }
  return next(req);
};
