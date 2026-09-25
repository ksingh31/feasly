import { Injectable, signal } from '@angular/core';

/**
 * A failed user action the /error page can re-fire via "Try again" (HRD-02).
 *
 * The retry callback re-runs the failed work (e.g. reload the page, re-run
 * the estimate pipeline). It must be idempotent — "Try again" may be tapped
 * more than once. The callback never surfaces error details; the error page
 * renders static copy only, so no stack trace or PII can leak into the DOM.
 */
export interface FailedAction {
  /** Human label for the action, e.g. 'Reload the current page'. */
  description: string;
  /** Re-runs the failed action. */
  retry: () => void;
}

/**
 * Holds the last failed action for the /error page's "Try again" button.
 *
 * A plain injectable (not NGXS): the retry callback is a closure and is not
 * serializable, and this is ephemeral session state — there is nothing to
 * persist across reloads.
 */
@Injectable({ providedIn: 'root' })
export class ErrorRecoveryService {
  private readonly lastAction = signal<FailedAction | null>(null);

  /** The currently captured failed action, if any. */
  readonly failedAction = this.lastAction.asReadonly();

  /** Captures the action a failure interrupted. Overwrites any previous one. */
  capture(action: FailedAction): void {
    this.lastAction.set(action);
  }

  /** Forgets the captured action (e.g. the user navigated away). */
  clear(): void {
    this.lastAction.set(null);
  }

  /**
   * Re-fires the captured action. Returns true when an action ran, false
   * when there was nothing to retry (the caller falls back to a reload).
   */
  retry(): boolean {
    const action = this.lastAction();
    if (!action) {
      return false;
    }
    this.clear();
    action.retry();
    return true;
  }
}
