import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ErrorRecoveryService } from '../../core/errors/error-recovery.service';

/**
 * In-shell admin error state (#472).
 *
 * Uncaught failures on admin routes land here via `GlobalErrorHandler`
 * instead of the public `/error` page, so admins keep the admin nav and
 * sign-out. The handler navigates with `skipLocationChange`, so the address
 * bar still shows the failing page and "Try again" (a reload) retries it.
 *
 * Static copy only — no error text, stack trace, or PII reaches the DOM.
 * The title comes from the seo-routes `admin/**` fallback via the shell.
 */
@Component({
  selector: 'app-admin-error',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './admin-error.component.html',
  styleUrl: './admin-error.component.scss',
})
export class AdminErrorComponent {
  private readonly recovery = inject(ErrorRecoveryService);

  /** Re-fires the captured failed action; falls back to a page reload. */
  protected tryAgain(): void {
    if (!this.recovery.retry()) {
      window.location.reload();
    }
  }
}
