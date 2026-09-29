import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Store } from '@ngxs/store';
import { ConfigService } from '../config/config.service';
import { AdminAuthState } from '../../features/admin/admin-auth.state';
import { BuilderState } from '../../features/builder/builder.state';

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
 * `feasly_admin_session` / `feasly_builder_session` HttpOnly cookies
 * (`SameSite=None; Secure`) flow where the browser accepts them — and,
 * crucially, admin/builder API requests ALSO carry
 * `Authorization: Bearer <token>` from the NGXS auth states, because
 * modern browsers block the third-party session cookie cross-origin and
 * the cookie alone can never authenticate the SPA.
 *
 * Scoped strictly to the configured API base URL: third-party calls (City
 * of Calgary Socrata, the config JSON fetch) never receive credentials.
 * When `api.baseUrl` is empty (mock mode / compiled default) this is a
 * no-op — relative `/api/v1/...` URLs are same-origin, where the browser
 * sends cookies regardless.
 *
 * Security note: the bearer token lives in client storage (NGXS storage
 * plugin → localStorage), which is XSS-stealable where an httpOnly cookie
 * was not. This is the standard, accepted tradeoff for cross-origin SPAs —
 * the cookie simply does not work cross-origin on modern browsers.
 */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) => {
  const baseUrl = inject(ConfigService).get('api').baseUrl;
  const store = inject(Store);
  if (isApiRequest(req.url, baseUrl)) {
    req = req.clone({ withCredentials: true });
    const token = bearerTokenFor(req.url, baseUrl, store);
    if (token) {
      req = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
    }
  }
  return next(req);
};

/**
 * The session token for admin/builder API paths, from the matching NGXS
 * auth state. Null for everything else (consumer/report/embed traffic is
 * token-scoped per-request, never ambient).
 */
function bearerTokenFor(url: string, baseUrl: string, store: Store): string | null {
  const path = url.slice(baseUrl.length);
  if (path.startsWith('/api/v1/admin/')) {
    return store.selectSnapshot(AdminAuthState.sessionToken);
  }
  if (
    path.startsWith('/api/v1/builder/') ||
    path.startsWith('/api/v1/billing/')
  ) {
    // /api/v1/billing/* is the builder billing surface (card on file,
    // invoices, report-contract) — same builder session, same token.
    return store.selectSnapshot(BuilderState.sessionToken);
  }
  return null;
}
