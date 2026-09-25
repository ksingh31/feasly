import { ErrorHandler, inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { ErrorRecoveryService } from './error-recovery.service';

/**
 * Global error handler (HRD-02): uncaught client errors route to the branded
 * `/error` page instead of leaving a blank screen.
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

  handleError(error: unknown): void {
    // Console only — the error page renders static, story-pinned copy.
    console.error('[Feasly] uncaught error:', error);
    // Never loop: if the error page itself throws, stay put.
    if (this.router.url.startsWith('/error')) {
      return;
    }
    this.recovery.capture({
      description: 'Reload the current page',
      retry: () => window.location.reload(),
    });
    void this.router.navigate(['/error']);
  }
}
