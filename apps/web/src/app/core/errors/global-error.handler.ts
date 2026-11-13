import { ErrorHandler, inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { ErrorRecoveryService } from './error-recovery.service';

/** Admin error state rendered inside the admin shell (#472). */
const ADMIN_ERROR_PATH = '/admin/error';

/** Admin routes that live outside the admin shell (no nav to keep). */
const ADMIN_OUTSIDE_SHELL = ['/admin/login', '/admin/auth'];

/** Whether `url` is an admin route rendered inside the admin shell. */
function isInAdminShell(url: string): boolean {
  const path = url.split(/[?#]/)[0];
  if (path !== '/admin' && !path.startsWith('/admin/')) {
    return false;
  }
  return !ADMIN_OUTSIDE_SHELL.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * Global error handler (HRD-02): uncaught client errors route to the branded
 * `/error` page instead of leaving a blank screen. Failures inside the admin
 * shell route to `/admin/error` instead (#472), so admins keep the admin nav
 * and never see the public error page. That navigation skips the location
 * change: the address bar keeps the failing URL, so a reload retries it.
 *
 * The raw error is logged to the console ONLY — it never reaches the DOM, so
 * no stack trace, message text, or PII (e.g. a lead's email caught in a
 * closure) can leak to the user. The captured retry simply reloads the
 * current page: for an unknown failure that is the only honest "try again".
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly router = inject(Router);
  private readonly recovery = inject(ErrorRecoveryService);

  /**
   * True while a navigation to the admin error state is in flight. A second
   * failure in that window (e.g. the admin shell itself throws) falls back
   * to the public `/error` page instead of looping.
   */
  private adminErrorPending = false;

  handleError(error: unknown): void {
    // Console only — the error page renders static, story-pinned copy.
    console.error('[Feasly] uncaught error:', error);
    // Never loop: if an error page itself throws, stay put.
    const url = this.router.url;
    if (url.startsWith('/error') || url.startsWith(ADMIN_ERROR_PATH)) {
      return;
    }
    // Remember where the failure happened so the error page's "Back to home"
    // can return admins to the admin home instead of the public homepage.
    const from = url;
    this.recovery.capture({
      description: 'Reload the current page',
      retry: () => window.location.reload(),
    });
    if (isInAdminShell(url) && !this.adminErrorPending) {
      this.routeToAdminError(from);
      return;
    }
    this.routeToPublicError(from);
  }

  private routeToAdminError(from: string): void {
    this.adminErrorPending = true;
    this.router
      .navigateByUrl(ADMIN_ERROR_PATH, { skipLocationChange: true })
      .then(
        (ok) => {
          if (!ok) {
            this.routeToPublicError(from);
          }
        },
        () => this.routeToPublicError(from),
      )
      .finally(() => {
        this.adminErrorPending = false;
      });
  }

  private routeToPublicError(from: string): void {
    void this.router.navigate(['/error'], { state: { from } });
  }
}
