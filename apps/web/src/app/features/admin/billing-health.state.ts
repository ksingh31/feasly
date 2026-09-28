import { inject, Injectable } from '@angular/core';
import { Action, Selector, State, StateContext, provideStates } from '@ngxs/store';
import { catchError, of, tap } from 'rxjs';
import type {
  BillingHealthResponse,
  ManualInvoiceResponse,
} from '@feasly/contracts';
import { AdminBillingApiService } from './admin-billing-api.service';
import {
  CreateManualInvoice,
  DismissCreateInvoiceFeedback,
  LoadBillingHealth,
  RetryInvoiceCharge,
} from './billing-health.actions';

/** Loading lifecycle for the billing-health dashboard. */
export type BillingHealthLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Lifecycle of the manual-invoice creation form submit. */
export type CreateInvoiceStatus = 'idle' | 'submitting' | 'error';

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
  /** Manual-invoice submit lifecycle. */
  createStatus: CreateInvoiceStatus;
  /** One-shot create-invoice feedback; carries the created invoice. */
  createFeedback: {
    ok: boolean;
    message: string;
    invoice: ManualInvoiceResponse | null;
  } | null;
}

const defaults: BillingHealthStateModel = {
  health: null,
  loadStatus: 'idle',
  error: null,
  retryingInvoiceId: null,
  retryFeedback: null,
  createStatus: 'idle',
  createFeedback: null,
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

  @Selector()
  static createStatus(
    state: BillingHealthStateModel,
  ): BillingHealthStateModel['createStatus'] {
    return state.createStatus;
  }

  @Selector()
  static createFeedback(
    state: BillingHealthStateModel,
  ): BillingHealthStateModel['createFeedback'] {
    return state.createFeedback;
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

  /**
   * Manually create a commission invoice. On success the dashboard payload
   * reloads so the in-review aging reflects the new invoice, and the
   * feedback carries the created invoice (id, status, 1% figure) for the
   * confirmation screen.
   */
  @Action(CreateManualInvoice)
  createManualInvoice(
    ctx: StateContext<BillingHealthStateModel>,
    action: CreateManualInvoice,
  ) {
    ctx.patchState({ createStatus: 'submitting', createFeedback: null });
    return this.api.createManualInvoice(action.body).pipe(
      tap((invoice) => {
        ctx.patchState({
          createStatus: 'idle',
          createFeedback: {
            ok: true,
            message: 'Invoice created and submitted into review.',
            invoice,
          },
        });
        // Reload the dashboard so the in-review aging shows the new invoice.
        ctx.dispatch(new LoadBillingHealth());
      }),
      catchError((err: unknown) => {
        ctx.patchState({
          createStatus: 'error',
          createFeedback: {
            ok: false,
            message: friendlyCreateError(err),
            invoice: null,
          },
        });
        return of(null);
      }),
    );
  }

  /** Dismiss the create-invoice feedback banner. */
  @Action(DismissCreateInvoiceFeedback)
  dismissCreateInvoiceFeedback(ctx: StateContext<BillingHealthStateModel>) {
    ctx.patchState({ createStatus: 'idle', createFeedback: null });
  }
}

/**
 * Map a create-invoice failure to user-facing copy. The raw error never
 * reaches the UI; specific cases are named so the admin can act on them.
 */
function friendlyCreateError(err: unknown): string {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? (err as { status?: unknown }).status
      : undefined;
  const code =
    typeof err === 'object' &&
    err !== null &&
    'error' in err &&
    typeof (err as { error?: unknown }).error === 'object' &&
    (err as { error?: unknown }).error !== null
      ? ((err as { error: { code?: unknown } }).error.code as
          | string
          | undefined)
      : undefined;
  if (status === 404) return 'That lead id was not found — check it and try again.';
  if (status === 403) return 'That lead belongs to a different builder — pick the matching one.';
  if (status === 422 && code === 'VALIDATION_FAILED')
    return 'The signing date is outside the 12-month attribution window.';
  if (status === 422)
    return 'The current billing model does not support per-event invoices.';
  return 'Invoice creation failed — check the details and try again.';
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
