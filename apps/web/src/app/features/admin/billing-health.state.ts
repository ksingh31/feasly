import { inject, Injectable } from '@angular/core';
import { Action, Selector, State, StateContext, provideStates } from '@ngxs/store';
import { catchError, of, tap, type Observable } from 'rxjs';
import type {
  AdminLeadListItem,
  AdminSetInvoicePaymentMethodResponse,
  BillingHealthResponse,
  BuilderPaymentMethod,
  CorrectContractResponse,
  ManualInvoiceResponse,
  MarkInvoicePaidResponse,
  RefundInvoiceResponse,
  ReverseManualPaymentResponse,
  SetCommissionRateResponse,
  UpdateInvoiceDunningRequest,
  VoidInvoiceResponse,
} from '@feasly/contracts';
import {
  AdminBillingApiService,
  PLANNED_PAYMENT_METHOD_LABELS,
} from './admin-billing-api.service';
import { AdminLeadsApiService } from './admin-leads-api.service';
import {
  ClearInvoiceLeads,
  CorrectInvoiceContract,
  CreateManualInvoice,
  DismissCreateInvoiceFeedback,
  DismissInvoiceFeedback,
  LoadBillingHealth,
  MarkInvoicePaid,
  RefundInvoice,
  RetryInvoiceCharge,
  ReverseInvoicePayment,
  SearchInvoiceLeads,
  SetCommissionRate,
  SetInvoicePlannedPaymentMethod,
  UpdateInvoiceDunning,
  VoidInvoice,
} from './billing-health.actions';

/** Loading lifecycle for the billing-health dashboard. */
export type BillingHealthLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Lifecycle of the manual-invoice creation form submit. */
export type CreateInvoiceStatus = 'idle' | 'submitting' | 'error';

/** Lifecycle of the mark-paid / rate-override submit in the manage modal. */
export type InvoiceActionStatus = 'idle' | 'submitting' | 'error';

/** Lifecycle of the create-invoice lead-picker search (#544). */
export type InvoiceLeadSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Results per lead-picker search; the admin narrows by typing. */
export const INVOICE_LEAD_SEARCH_LIMIT = 20;

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
  /** Mark-paid / rate-override submit lifecycle in the manage modal. */
  invoiceActionStatus: InvoiceActionStatus;
  /**
   * One-shot mark-paid / rate-override / payment-method feedback; carries
   * the updated invoice. Shown in the manage modal; a success also
   * reloads the dashboard so the work queue reflects the new state.
   */
  invoiceFeedback: {
    ok: boolean;
    message: string;
    invoice:
      | MarkInvoicePaidResponse
      | SetCommissionRateResponse
      | AdminSetInvoicePaymentMethodResponse
      | RefundInvoiceResponse
      | VoidInvoiceResponse
      | CorrectContractResponse
      | ReverseManualPaymentResponse
      | null;
  } | null;
  /** Create-invoice lead picker results for the chosen builder (#544). */
  invoiceLeads: readonly AdminLeadListItem[];
  invoiceLeadSearchStatus: InvoiceLeadSearchStatus;
  /** #901: invoice whose dunning schedule is being saved, or null. */
  dunningSavingId: string | null;
  /**
   * #901: one-shot outcome of the last schedule change. Copy-free — the
   * page maps `action` / `conflict` to admin copy for the toast.
   */
  dunningFeedback: {
    invoiceId: string;
    action: UpdateInvoiceDunningRequest['action'];
    ok: boolean;
    /** The server refused because the invoice changed state (409). */
    conflict: boolean;
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
  invoiceActionStatus: 'idle',
  invoiceFeedback: null,
  invoiceLeads: [],
  invoiceLeadSearchStatus: 'idle',
  dunningSavingId: null,
  dunningFeedback: null,
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
  private readonly leadsApi = inject(AdminLeadsApiService);

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

  /**
   * True when the webhook receiver looks unhealthy: unhandled / mismatched
   * events in the last 24h, or (#711) unprocessed events / invoices
   * awaiting settlement.
   */
  @Selector()
  static hasWebhookIssues(state: BillingHealthStateModel): boolean {
    const webhooks = state.health?.webhooks;
    if (!webhooks) return false;
    return (
      webhooks.unhandled24h > 0 ||
      webhooks.modelMismatch24h > 0 ||
      (webhooks.unprocessed?.length ?? 0) > 0 ||
      (webhooks.awaitingSettlement?.length ?? 0) > 0
    );
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

  /** Mark-paid / rate-override submit lifecycle (manage modal). */
  @Selector()
  static invoiceActionStatus(
    state: BillingHealthStateModel,
  ): BillingHealthStateModel['invoiceActionStatus'] {
    return state.invoiceActionStatus;
  }

  /** One-shot mark-paid / rate-override feedback (manage modal). */
  @Selector()
  static invoiceFeedback(
    state: BillingHealthStateModel,
  ): BillingHealthStateModel['invoiceFeedback'] {
    return state.invoiceFeedback;
  }

  /** #901: invoice whose dunning schedule is being saved, or null. */
  @Selector()
  static dunningSavingId(state: BillingHealthStateModel): string | null {
    return state?.dunningSavingId ?? null;
  }

  /** #901: outcome of the last dunning schedule change. */
  @Selector()
  static dunningFeedback(
    state: BillingHealthStateModel,
  ): BillingHealthStateModel['dunningFeedback'] {
    return state?.dunningFeedback ?? null;
  }

  /** Lead-picker results for the create-invoice modal (#544). */
  @Selector()
  static invoiceLeads(
    state: BillingHealthStateModel,
  ): readonly AdminLeadListItem[] {
    return state.invoiceLeads;
  }

  @Selector()
  static invoiceLeadSearchStatus(
    state: BillingHealthStateModel,
  ): InvoiceLeadSearchStatus {
    return state.invoiceLeadSearchStatus;
  }

  /**
   * Lead-picker search (#544): the builder's assigned leads, optionally
   * narrowed by free text. `cancelUncompleted` drops a slower earlier
   * search so stale results never replace newer ones.
   */
  @Action(SearchInvoiceLeads, { cancelUncompleted: true })
  searchInvoiceLeads(
    ctx: StateContext<BillingHealthStateModel>,
    action: SearchInvoiceLeads,
  ) {
    ctx.patchState({ invoiceLeadSearchStatus: 'loading' });
    const search = action.search.trim();
    return this.leadsApi
      .listLeads(
        {
          builderId: action.builderId,
          ...(search.length > 0 ? { search } : {}),
        },
        null,
        INVOICE_LEAD_SEARCH_LIMIT,
      )
      .pipe(
        tap((res) =>
          ctx.patchState({
            invoiceLeads: res.leads,
            invoiceLeadSearchStatus: 'ready',
          }),
        ),
        catchError(() => {
          ctx.patchState({ invoiceLeads: [], invoiceLeadSearchStatus: 'error' });
          return of(null);
        }),
      );
  }

  @Action(ClearInvoiceLeads)
  clearInvoiceLeads(ctx: StateContext<BillingHealthStateModel>) {
    ctx.patchState({ invoiceLeads: [], invoiceLeadSearchStatus: 'idle' });
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
      catchError((error: unknown) => {
        // Prefer the server's message (e.g. the manual-method 409 explains
        // the retry was refused and what to do instead); fall back to the
        // generic copy when the failure has no useful message.
        const rawMessage = (error as { message?: unknown } | null)?.message;
        const serverMessage: string | null =
          typeof rawMessage === 'string' && rawMessage.length > 0
            ? rawMessage
            : null;
        ctx.patchState({
          retryingInvoiceId: null,
          retryFeedback: {
            invoiceId: action.invoiceId,
            ok: false,
            message:
              serverMessage ??
              'Retry failed. Check the card on file and try again.',
          },
        });
        return of(null);
      }),
    );
  }

  /**
   * #901: edit one invoice's retry schedule. One change at a time (a
   * dispatch while another saves is ignored). Success reloads the
   * dashboard; the outcome lands in `dunningFeedback` for the page's toast
   * and the grace-days modal's inline error.
   */
  @Action(UpdateInvoiceDunning)
  updateInvoiceDunning(
    ctx: StateContext<BillingHealthStateModel>,
    action: UpdateInvoiceDunning,
  ) {
    if (ctx.getState().dunningSavingId !== null) return;
    ctx.patchState({ dunningSavingId: action.invoiceId, dunningFeedback: null });
    return this.api.updateInvoiceDunning(action.invoiceId, action.body).pipe(
      tap(() => {
        ctx.patchState({
          dunningSavingId: null,
          dunningFeedback: { invoiceId: action.invoiceId, action: action.body.action, ok: true, conflict: false },
        });
        ctx.dispatch(new LoadBillingHealth());
      }),
      catchError((err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code;
        ctx.patchState({
          dunningSavingId: null,
          dunningFeedback: {
            invoiceId: action.invoiceId,
            action: action.body.action,
            ok: false,
            conflict: code === 'CONFLICT' || code === 'http_409',
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

  /**
   * Record an off-Stripe payment. On success the dashboard payload reloads
   * so the invoice leaves the in-review/dunning work queue, and the
   * feedback carries the paid invoice for the modal's confirmation.
   */
  @Action(MarkInvoicePaid)
  markInvoicePaid(
    ctx: StateContext<BillingHealthStateModel>,
    action: MarkInvoicePaid,
  ) {
    ctx.patchState({ invoiceActionStatus: 'submitting', invoiceFeedback: null });
    return this.api.markInvoicePaid(action.invoiceId, action.body).pipe(
      tap((invoice) => {
        ctx.patchState({
          invoiceActionStatus: 'idle',
          invoiceFeedback: {
            ok: true,
            message: 'Invoice marked as paid — the scheduled auto-charge was cancelled.',
            invoice,
          },
        });
        ctx.dispatch(new LoadBillingHealth());
      }),
      catchError((err: unknown) => {
        ctx.patchState({
          invoiceActionStatus: 'error',
          invoiceFeedback: {
            ok: false,
            message: friendlyInvoiceActionError(err),
            invoice: null,
          },
        });
        return of(null);
      }),
    );
  }

  /**
   * Override the per-invoice commission rate. On success the dashboard
   * payload reloads so the work queue shows the recalculated amount.
   */
  @Action(SetCommissionRate)
  setCommissionRate(
    ctx: StateContext<BillingHealthStateModel>,
    action: SetCommissionRate,
  ) {
    ctx.patchState({ invoiceActionStatus: 'submitting', invoiceFeedback: null });
    return this.api.setCommissionRate(action.invoiceId, action.rate).pipe(
      tap((invoice) => {
        ctx.patchState({
          invoiceActionStatus: 'idle',
          invoiceFeedback: {
            ok: true,
            message:
              `Commission rate set to ${action.rate}% — ` +
              'the invoice amount was recalculated.',
            invoice,
          },
        });
        ctx.dispatch(new LoadBillingHealth());
      }),
      catchError((err: unknown) => {
        ctx.patchState({
          invoiceActionStatus: 'error',
          invoiceFeedback: {
            ok: false,
            message: friendlyInvoiceActionError(err),
            invoice: null,
          },
        });
        return of(null);
      }),
    );
  }

  /**
   * #862: refund a paid invoice (#715). The modal reuses one idempotency
   * key per open, so retrying after a failure never refunds twice.
   */
  @Action(RefundInvoice)
  refundInvoice(ctx: StateContext<BillingHealthStateModel>, action: RefundInvoice) {
    return this.invoiceAction(
      ctx,
      this.api.refundInvoice(action.invoiceId, action.body),
      (res) =>
        res.refundState === 'refunded'
          ? 'Invoice refunded in full.'
          : 'Partial refund issued — the invoice stays paid for the rest.',
      friendlyRefundError,
    );
  }

  /** #862: void an unpaid invoice (#715). */
  @Action(VoidInvoice)
  voidInvoice(ctx: StateContext<BillingHealthStateModel>, action: VoidInvoice) {
    return this.invoiceAction(
      ctx,
      this.api.voidInvoice(action.invoiceId, action.body),
      () => 'Invoice voided — it will not be charged.',
      friendlyAdjustmentError,
    );
  }

  /** #862: correct the reported contract before the invoice is charged (#715). */
  @Action(CorrectInvoiceContract)
  correctInvoiceContract(ctx: StateContext<BillingHealthStateModel>, action: CorrectInvoiceContract) {
    return this.invoiceAction(
      ctx,
      this.api.correctContract(action.invoiceId, action.body),
      (res) =>
        res.status === 'in_review'
          ? 'Contract corrected — the amounts were recalculated and a new review window started.'
          : 'Contract corrected — the amounts were recalculated.',
      friendlyAdjustmentError,
    );
  }

  /** #862: undo a manual mark-paid — the invoice moves to failed (#715). */
  @Action(ReverseInvoicePayment)
  reverseInvoicePayment(ctx: StateContext<BillingHealthStateModel>, action: ReverseInvoicePayment) {
    return this.invoiceAction(
      ctx,
      this.api.reversePayment(action.invoiceId, action.body),
      () => 'Payment reversed — the invoice is unpaid again and nothing is charged automatically.',
      friendlyAdjustmentError,
    );
  }

  /**
   * Shared lifecycle for the #862 invoice actions: submitting → feedback
   * (the modal reads it, toasts on success, shows the error inline), and
   * a dashboard reload on success.
   */
  private invoiceAction<
    R extends RefundInvoiceResponse | VoidInvoiceResponse | CorrectContractResponse | ReverseManualPaymentResponse,
  >(
    ctx: StateContext<BillingHealthStateModel>,
    request: Observable<R>,
    success: (res: R) => string,
    failure: (err: unknown) => string,
  ) {
    ctx.patchState({ invoiceActionStatus: 'submitting', invoiceFeedback: null });
    return request.pipe(
      tap((invoice) => {
        ctx.patchState({
          invoiceActionStatus: 'idle',
          invoiceFeedback: { ok: true, message: success(invoice), invoice },
        });
        ctx.dispatch(new LoadBillingHealth());
      }),
      catchError((err: unknown) => {
        ctx.patchState({
          invoiceActionStatus: 'error',
          invoiceFeedback: { ok: false, message: failure(err), invoice: null },
        });
        return of(null);
      }),
    );
  }

  /** Dismiss the mark-paid / rate-override feedback banner. */
  @Action(DismissInvoiceFeedback)
  dismissInvoiceFeedback(ctx: StateContext<BillingHealthStateModel>) {
    ctx.patchState({ invoiceActionStatus: 'idle', invoiceFeedback: null });
  }

  /**
   * Change the planned payment method on one invoice. On success the
   * dashboard payload reloads so the work queue shows the new method.
   */
  @Action(SetInvoicePlannedPaymentMethod)
  setInvoicePlannedPaymentMethod(
    ctx: StateContext<BillingHealthStateModel>,
    action: SetInvoicePlannedPaymentMethod,
  ) {
    ctx.patchState({ invoiceActionStatus: 'submitting', invoiceFeedback: null });
    return this.api
      .setInvoicePaymentMethod(action.invoiceId, action.method)
      .pipe(
        tap((invoice) => {
          const manual = invoice.paymentMethod !== 'card';
          ctx.patchState({
            invoiceActionStatus: 'idle',
            invoiceFeedback: {
              ok: true,
              message:
                `Payment method set to ${plannedMethodLabel(invoice.paymentMethod)}. ` +
                (manual
                  ? 'The Stripe auto-charge is paused until the payment is recorded.'
                  : 'The scheduled Stripe auto-charge is armed.'),
              invoice,
            },
          });
          ctx.dispatch(new LoadBillingHealth());
        }),
        catchError((err: unknown) => {
          ctx.patchState({
            invoiceActionStatus: 'error',
            invoiceFeedback: {
              ok: false,
              message: friendlyInvoiceActionError(err),
              invoice: null,
            },
          });
          return of(null);
        }),
      );
  }
}

/**
 * Map a mark-paid / rate-override / payment-method failure to
 * user-facing copy. The raw error never reaches the UI; specific cases
 * are named so the admin can act on them.
 */
function friendlyInvoiceActionError(err: unknown): string {
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
  if (status === 404) return 'That invoice was not found — it may have been handled already.';
  if (status === 400 && code === 'VALIDATION_FAILED')
    return 'Check the payment details — the method, reference, or rate is invalid.';
  if (status === 409)
    return 'That invoice changed state — it may already be paid. Refresh and try again.';
  return 'The update failed — check the details and try again.';
}

/**
 * #862: void / correct-contract / reverse-payment failures. The raw error
 * never reaches the UI.
 */
function friendlyAdjustmentError(err: unknown): string {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? (err as { status?: unknown }).status
      : undefined;
  if (status === 404) return 'That invoice was not found — it may have been handled already.';
  if (status === 400 || status === 422) return 'Check the details — a required field is missing or invalid.';
  if (status === 409) return 'That invoice changed state, so this action no longer applies. Refresh and try again.';
  return 'The update failed — check the details and try again.';
}

/**
 * #862: refund failures. A 422 names the two rules an admin can fix (the
 * amount left, the off-Stripe reference); anything that may have reached
 * Stripe says a retry is safe — the same idempotency key is reused.
 */
function friendlyRefundError(err: unknown): string {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? (err as { status?: unknown }).status
      : undefined;
  if (status === 404) return 'That invoice was not found — it may have been handled already.';
  if (status === 400) return 'Check the refund details — the amount, reason or reference is invalid.';
  if (status === 422)
    return 'The refund can’t go ahead: it can’t exceed what is left to refund, and an off-Stripe payment needs a reference.';
  if (status === 409) return 'That invoice changed state — it may no longer be paid. Refresh and try again.';
  return 'The refund did not go through. Try again — it is the same request, so the invoice is never refunded twice.';
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

/** Plain admin label for a planned payment method. */
function plannedMethodLabel(method: BuilderPaymentMethod): string {
  return (
    PLANNED_PAYMENT_METHOD_LABELS.find((option) => option.value === method)
      ?.label ?? method
  );
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
