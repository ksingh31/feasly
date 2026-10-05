import { inject, Injectable } from '@angular/core';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import { catchError, of, tap } from 'rxjs';
import { BuilderInvoicesApiService } from '../builder/builder-invoices-api.service';
import type { BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';
import {
  ADMIN_INVOICE_STATUS_OPTIONS,
  ClearAdminInvoiceDetail,
  DismissAdminInvoiceDetailError,
  DismissAdminInvoiceListError,
  LoadAdminInvoiceDetail,
  LoadAdminInvoices,
  SetAdminInvoiceFilters,
} from './admin-invoices.actions';
import type { AdminInvoiceFilters } from './admin-invoices.actions';

/** Loading lifecycle for the admin invoice list. */
export type AdminInvoicesLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Loading lifecycle for the admin invoice detail. */
export type AdminInvoiceDetailStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface AdminInvoicesStateModel {
  /** Current page of invoices (newest first). Empty before the first load. */
  invoices: readonly BuilderCommissionInvoice[];
  /** Backend-reported total, or null when the endpoint doesn't report one. */
  total: number | null;
  page: number;
  pageSize: number;
  filters: AdminInvoiceFilters;
  listStatus: AdminInvoicesLoadStatus;
  /** Friendly list error message, or null. */
  listError: string | null;
  /** The invoice open in the detail view, or null. */
  detail: BuilderCommissionInvoice | null;
  detailStatus: AdminInvoiceDetailStatus;
  /** Friendly detail error message, or null. */
  detailError: string | null;
}

const DEFAULT_FILTERS: AdminInvoiceFilters = { status: null, invoiceNumber: null };

const defaults: AdminInvoicesStateModel = {
  invoices: [],
  total: null,
  page: 1,
  pageSize: 20,
  filters: DEFAULT_FILTERS,
  listStatus: 'idle',
  listError: null,
  detail: null,
  detailStatus: 'idle',
  detailError: null,
};

/**
 * Admin invoice list + detail state (QA admin-console fix 3).
 *
 * Reuses `BuilderInvoicesApiService` — the admin session cookie is accepted
 * by the backend's `adminGuard.requireAdmin` fallback on the
 * `/api/v1/billing/invoices` endpoints with `tenantKey: null`, which
 * returns every tenant's invoices. Same pattern as AdminBillingApiService
 * importing from `../builder/`.
 *
 * The action handlers RETURN their API observables (never a bare
 * `.subscribe()`): NGXS then owns the subscription, so a newer
 * `LoadAdminInvoices` cancels an in-flight load and no stale response can
 * overwrite a newer one.
 *
 * Memory-only: never added to the storage plugin (invoice data goes
 * stale — each visit reloads).
 */
@State<AdminInvoicesStateModel>({
  name: 'adminInvoices',
  defaults,
})
@Injectable()
export class AdminInvoicesState {
  private readonly api = inject(BuilderInvoicesApiService);

  /**
   * Friendly message for an API failure: prefer the server's message,
   * fall back to generic copy.
   */
  private static errorMessage(error: unknown, fallback: string): string {
    const raw = (error as { message?: unknown } | null)?.message;
    return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
  }

  @Selector()
  static invoices(
    state: AdminInvoicesStateModel,
  ): readonly BuilderCommissionInvoice[] {
    return state.invoices;
  }

  @Selector()
  static total(state: AdminInvoicesStateModel): number | null {
    return state.total;
  }

  @Selector()
  static page(state: AdminInvoicesStateModel): number {
    return state.page;
  }

  @Selector()
  static pageSize(state: AdminInvoicesStateModel): number {
    return state.pageSize;
  }

  @Selector()
  static filters(state: AdminInvoicesStateModel): AdminInvoiceFilters {
    return state.filters;
  }

  @Selector()
  static listStatus(state: AdminInvoicesStateModel): AdminInvoicesLoadStatus {
    return state.listStatus;
  }

  @Selector()
  static listError(state: AdminInvoicesStateModel): string | null {
    return state.listError;
  }

  @Selector()
  static detail(
    state: AdminInvoicesStateModel,
  ): BuilderCommissionInvoice | null {
    return state.detail;
  }

  @Selector()
  static detailStatus(state: AdminInvoicesStateModel): AdminInvoiceDetailStatus {
    return state.detailStatus;
  }

  @Selector()
  static detailError(state: AdminInvoicesStateModel): string | null {
    return state.detailError;
  }

  @Action(LoadAdminInvoices)
  loadInvoices(
    ctx: StateContext<AdminInvoicesStateModel>,
    action: LoadAdminInvoices,
  ) {
    const state = ctx.getState();
    const filters = action.filters ?? state.filters;
    ctx.patchState({
      listStatus: 'loading',
      listError: null,
      filters,
      page: Math.max(1, action.page),
      pageSize: action.pageSize,
    });
    return this.api
      .listInvoices(action.page, action.pageSize, filters.invoiceNumber ?? undefined, filters.status ?? undefined)
      .pipe(
        tap((response) =>
          ctx.patchState({
            invoices: response.invoices,
            total: response.total,
            page: response.page,
            pageSize: response.pageSize,
            listStatus: 'ready',
          }),
        ),
        catchError((error: unknown) => {
          // Swallow the error into user-facing state. Without this
          // catchError the ApiError propagates through the NGXS dispatch
          // stream as an unhandled error and lands the admin on the
          // branded /error page (2026-09-27).
          ctx.patchState({
            invoices: [],
            listStatus: 'error',
            listError: AdminInvoicesState.errorMessage(
              error,
              'Could not load invoices. Please try again.',
            ),
          });
          return of(null);
        }),
      );
  }

  @Action(SetAdminInvoiceFilters)
  setFilters(
    ctx: StateContext<AdminInvoicesStateModel>,
    action: SetAdminInvoiceFilters,
  ) {
    ctx.patchState({ filters: action.filters });
    return ctx.dispatch(new LoadAdminInvoices(1, ctx.getState().pageSize, action.filters));
  }

  @Action(LoadAdminInvoiceDetail)
  loadDetail(
    ctx: StateContext<AdminInvoicesStateModel>,
    action: LoadAdminInvoiceDetail,
  ) {
    ctx.patchState({ detailStatus: 'loading', detailError: null, detail: null });
    return this.api.getInvoice(action.id).pipe(
      tap((invoice) =>
        ctx.patchState({ detail: invoice, detailStatus: 'ready' }),
      ),
      catchError((error: unknown) => {
        ctx.patchState({
          detail: null,
          detailStatus: 'error',
          detailError: AdminInvoicesState.errorMessage(
            error,
            'Could not load this invoice. Please try again.',
          ),
        });
        return of(null);
      }),
    );
  }

  @Action(ClearAdminInvoiceDetail)
  clearDetail(ctx: StateContext<AdminInvoicesStateModel>) {
    ctx.patchState({ detail: null, detailStatus: 'idle', detailError: null });
  }

  @Action(DismissAdminInvoiceListError)
  dismissListError(ctx: StateContext<AdminInvoicesStateModel>) {
    ctx.patchState({ listError: null });
  }

  @Action(DismissAdminInvoiceDetailError)
  dismissDetailError(ctx: StateContext<AdminInvoicesStateModel>) {
    ctx.patchState({ detailError: null });
  }
}

/** Route-level lazy provider — keeps the invoices chunk out of the initial bundle. */
export const adminInvoicesStateProvider = provideStates([AdminInvoicesState]);
