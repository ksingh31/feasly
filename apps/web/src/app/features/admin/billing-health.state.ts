import { inject, Injectable } from '@angular/core';
import { Action, Selector, State, StateContext, provideStates } from '@ngxs/store';
import { catchError, of, tap } from 'rxjs';
import type { BillingHealthResponse } from '@feasly/contracts';
import { AdminBillingApiService } from './admin-billing-api.service';
import { LoadBillingHealth, RetryInvoiceCharge } from './billing-health.actions';

/** Loading lifecycle for the billing-health dashboard. */
export type BillingHealthLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface BillingHealthStateModel {
  /** The latest dashboard payload, or null before the first load. */
  health: BillingHealthResponse | null;
  /** Load lifecycle. */
  loadStatus: BillingHealthLoadStatus;
  /** Load failure flag. The raw error never reaches the UI. */
  error: string | null;
  /** Invoice id currently retrying its charge, or null. BILL-03. */
  retryingInvoiceId: string | null;
  /** One-shot retry feedback shown in the dunning queue. BILL-03. */
  retryFeedback: {
    invoiceId: string;
    ok: boolean;
    message: string;
  } | null;
}

const defaults: BillingHealthStateModel = {
  health: null,
  loadStatus: 'idle',
  error: null,
  retryingInvoiceId: null,
  retryFeedback: null,
};

/**
 * Billing-health dashboard state (billing/03 follow-on — /admin/billing).
 *
 * Single source of truth for the `/admin/billing` page. The action handler
 * RETURNS its API observable (never a bare `.subscribe()`): NGXS then owns
 * the subscription, so a newer `LoadBillingHealth` cancels an in-flight
 * load and no stale response can overwrite a newer one.
 *
 * Memory-only: never added to the storage plugin (billing health goes
 * stale — each visit reloads).
 */
@State<BillingHealthStateModel>({
  name: 'billingHealth',
  defaults,
})
@Injectable()
export class BillingHealthState {
  private readonly api = inject(AdminBillingApiService);

  @Selector()
  static health(
    state: BillingHealthStateModel,
  ): BillingHealthResponse | null {
    return state.health;
  }

  @Selector()
  static loadStatus(
    state: BillingHealthStateModel,
  ): BillingHealthLoadStatus {
    return state.loadStatus;
  }

  @Selector()
  static error(state: BillingHealthStateModel): string | null {
    return state.error;
  }

  /** True when dunning needs attention (any failed-charge invoice). */
  @Selector()
  static hasDunning(state: BillingHealthStateModel): boolean {
    return (state.health?.dunning.length ?? 0) > 0;
  }

  /** True when the webhook receiver looks unhealthy in the last 24h. */
  @Selector()
  static hasWebhookIssues(state: BillingHealthStateModel): boolean {
    const webhooks = state.health?.webhooks;
    if (!webhooks) return false;
    return webhooks.unhandled24h > 0 || webhooks.modelMismatch24h > 0;
  }

  /** Invoice id currently retrying its charge, or null. BILL-03. */
  @Selector()
  static retryingInvoiceId(state: BillingHealthStateModel): string | null {
    return state.retryingInvoiceId;
  }

  /** One-shot retry feedback for the dunning queue. BILL-03. */
  @Selector()
  static retryFeedback(
    state: BillingHealthStateModel,
  ): BillingHealthStateModel['retryFeedback'] {
    return state.retryFeedback;
  }

  @Action(LoadBillingHealth)
  loadBillingHealth(ctx: StateContext<BillingHealthStateModel>) {
    ctx.patchState({ loadStatus: 'loading', error: null });
    return this.api.getBillingHealth().pipe(
      tap((health) =>
        ctx.patchState({ health, loadStatus: 'ready', error: null }),
      ),
      catchError(() => {
        ctx.patchState({
          loadStatus: 'error',
          error: 'Could not load billing health. Try again.',
        });
        return of(null);
      }),
    );
  }

  @Action(RetryInvoiceCharge)
  retryInvoiceCharge(
    ctx: StateContext<BillingHealthStateModel>,
    action: RetryInvoiceCharge,
  ) {
    ctx.patchState({
      retryingInvoiceId: action.invoiceId,
      retryFeedback: null,
    });
    return this.api.retryInvoiceCharge(action.invoiceId).pipe(
      tap((result) => {
        ctx.patchState({
          retryingInvoiceId: null,
          retryFeedback: {
            invoiceId: action.invoiceId,
            ok: true,
            message: `Charge re-attempted (retry ${result.retryCount}). ` +
              'Watch for the webhook outcome.',
          },
        });
        // Reload the dashboard so the dunning queue shows the fresh status.
        ctx.dispatch(new LoadBillingHealth());
      }),
      catchError(() => {
        ctx.patchState({
          retryingInvoiceId: null,
          retryFeedback: {
            invoiceId: action.invoiceId,
            ok: false,
            message: 'Retry failed. Check the card on file and try again.',
          },
        });
        return of(null);
      }),
    );
  }
}

/**
 * Route-level provider for the lazy `admin/billing` route.
 * Registered via `lazyProvider` in `app.routes.ts` with a dynamic import so
 * the state + its actions stay in the billing lazy chunk, out of the initial
 * bundle (790kB production budget). This is the fix for the 2026-09-27
 * incident: the state was never registered anywhere, so `/admin/billing`
 * crashed at init.
 */
export const billingHealthStateProvider = provideStates([BillingHealthState]);
