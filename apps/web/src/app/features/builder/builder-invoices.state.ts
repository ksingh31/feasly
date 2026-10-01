import { inject, Injectable, makeEnvironmentProviders } from '@angular/core';
import type { EnvironmentProviders } from '@angular/core';
import { of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { Action, NgxsOnInit, provideStates, Selector, State, StateContext } from '@ngxs/store';
import { BUILDER_COPY, provideBuilderCopy } from './builder-copy';
import {
  BuilderInvoicesApiService,
  type BuilderCommissionInvoice,
  type InvoiceListResponse,
} from './builder-invoices-api.service';
import type { BuilderPaymentMethod } from './builder-payment-methods';
import {
  ClearInvoicesState,
  ClearInvoiceSelection,
  LoadInvoices,
  SelectInvoice,
  SetInvoiceNumberFilter,
  UpdateInvoicePaymentMethod,
} from './builder-invoices.actions';

/** Loading lifecycle for the invoice list / detail. */
export type InvoicesStatus = 'idle' | 'loading' | 'ready' | 'error';

/** PUT lifecycle for the per-invoice payment method. */
export type InvoicePaymentMethodSaveStatus = 'idle' | 'saving' | 'error';

export interface BuilderInvoicesStateModel {
  /** Current page of invoices, newest first. Memory-only. */
  invoices: readonly BuilderCommissionInvoice[];
  /** Total invoice count across all pages; null when the backend reports none. */
  total: number | null;
  /** 1-based current page. */
  page: number;
  pageSize: number;
  listStatus: InvoicesStatus;
  /** Selected invoice for the detail view; null when closed. */
  selected: BuilderCommissionInvoice | null;
  detailStatus: InvoicesStatus;
  paymentMethodSaveStatus: InvoicePaymentMethodSaveStatus;
  /**
   * Server-side invoice-number search (partial, case-insensitive). Empty
   * means no filter. Persists across pagination; cleared with the state.
   */
  invoiceNumberFilter: string;
}

const defaults: BuilderInvoicesStateModel = {
  invoices: [],
  total: 0,
  page: 1,
  // Overridden from config in ngxsOnInit (builder.copy.invoicesPageSize).
  // Zero here: the checker flags multi-digit literals, and this value is
  // never read before ngxsOnInit patches it.
  pageSize: 0,
  listStatus: 'idle',
  selected: null,
  detailStatus: 'idle',
  paymentMethodSaveStatus: 'idle',
  invoiceNumberFilter: '',
};

/**
 * Builder invoices state (BILL-04): the single source of truth for the
 * `/builder/billing/invoices` list and detail view.
 *
 * Memory-only — invoice rows are re-fetched on each visit. Tenant scoping
 * is enforced server-side via the builder session; the state never filters
 * by tenant client-side.
 */
@State<BuilderInvoicesStateModel>({
  name: 'builderInvoices',
  defaults,
})
@Injectable()
export class BuilderInvoicesState implements NgxsOnInit {
  private readonly api = inject(BuilderInvoicesApiService);
  private readonly copy = inject(BUILDER_COPY);

  ngxsOnInit(ctx: StateContext<BuilderInvoicesStateModel>): void {
    ctx.patchState({
      pageSize: this.copy.invoicesPageSize,
    });
  }

  @Selector()
  static invoices(
    state: BuilderInvoicesStateModel,
  ): readonly BuilderCommissionInvoice[] {
    return state.invoices;
  }

  @Selector()
  static total(state: BuilderInvoicesStateModel): number | null {
    return state.total;
  }

  @Selector()
  static page(state: BuilderInvoicesStateModel): number {
    return state.page;
  }

  @Selector()
  static pageSize(state: BuilderInvoicesStateModel): number {
    return state.pageSize;
  }

  /** Null when the backend reports no total (bare-array pagination). */
  @Selector()
  static totalPages(state: BuilderInvoicesStateModel): number | null {
    if (state.total === null) {
      return null;
    }
    return Math.max(1, Math.ceil(state.total / state.pageSize));
  }

  @Selector()
  static listStatus(state: BuilderInvoicesStateModel): InvoicesStatus {
    return state.listStatus;
  }

  @Selector()
  static selected(
    state: BuilderInvoicesStateModel,
  ): BuilderCommissionInvoice | null {
    return state.selected;
  }

  @Selector()
  static paymentMethodSaveStatus(
    state: BuilderInvoicesStateModel,
  ): InvoicePaymentMethodSaveStatus {
    return state.paymentMethodSaveStatus;
  }

  @Selector()
  static detailStatus(state: BuilderInvoicesStateModel): InvoicesStatus {
    return state.detailStatus;
  }

  /** The active invoice-number search filter ('' = none). */
  @Selector()
  static invoiceNumberFilter(state: BuilderInvoicesStateModel): string {
    return state.invoiceNumberFilter;
  }

  @Action(LoadInvoices)
  loadPage(ctx: StateContext<BuilderInvoicesStateModel>, action: LoadInvoices) {
    // Pagination guard (2026-09-29): the state must never send the backend
    // invalid limit/offset — the zod validation in billing.route.ts
    // rejects them with 400 (live bug: intermittent 400s on the list).
    // - `page` is clamped to a finite ≥1 integer. Note Math.max(1, NaN)
    //   is NaN, which would poison the page signal and every retry after
    //   it, so non-finite input becomes 1 explicitly.
    // - `pageSize` falls back to the configured value when the state holds
    //   a non-positive one. ClearInvoicesState resets to defaults (pageSize
    //   0) but ngxsOnInit only runs once per store lifetime, so revisiting
    //   the page after navigating away would otherwise send limit=0.
    const rawPage = action.page;
    const page = Number.isFinite(rawPage)
      ? Math.max(1, Math.floor(rawPage))
      : 1;
    const configuredPageSize = this.copy.invoicesPageSize;
    const safeConfigured =
      Number.isFinite(configuredPageSize) && configuredPageSize > 0
        ? Math.min(100, Math.floor(configuredPageSize))
        : 20;
    const statePageSize = ctx.getState().pageSize;
    const pageSize =
      Number.isFinite(statePageSize) && statePageSize > 0
        ? Math.min(100, Math.floor(statePageSize))
        : safeConfigured;
    ctx.patchState({ listStatus: 'loading', page, pageSize });
    const invoiceNumberFilter = ctx.getState().invoiceNumberFilter.trim();
    return this.api
      .listInvoices(
        page,
        pageSize,
        invoiceNumberFilter === '' ? undefined : invoiceNumberFilter,
      )
      .pipe(
        tap((res: InvoiceListResponse) =>
          ctx.patchState({
            invoices: res.invoices,
            total: res.total,
            page: res.page,
            listStatus: 'ready',
          }),
        ),
        catchError(() => {
          ctx.patchState({ listStatus: 'error' });
          return of(null);
        }),
      );
  }

  @Action(SetInvoiceNumberFilter)
  setInvoiceNumberFilter(
    ctx: StateContext<BuilderInvoicesStateModel>,
    action: SetInvoiceNumberFilter,
  ) {
    const invoiceNumber = action.invoiceNumber.trim();
    if (invoiceNumber === ctx.getState().invoiceNumberFilter) {
      return;
    }
    ctx.patchState({ invoiceNumberFilter: invoiceNumber });
    ctx.dispatch(new LoadInvoices(1));
  }

  @Action(SelectInvoice)
  select(ctx: StateContext<BuilderInvoicesStateModel>, action: SelectInvoice) {
    ctx.patchState({ detailStatus: 'loading', selected: null });
    return this.api.getInvoice(action.id).pipe(
      tap((invoice) =>
        ctx.patchState({ selected: invoice, detailStatus: 'ready' }),
      ),
      catchError(() => {
        ctx.patchState({ detailStatus: 'error' });
        return of(null);
      }),
    );
  }

  @Action(ClearInvoiceSelection)
  clearSelection(ctx: StateContext<BuilderInvoicesStateModel>) {
    ctx.patchState({ selected: null, detailStatus: 'idle' });
  }

  @Action(UpdateInvoicePaymentMethod)
  updatePaymentMethod(
    ctx: StateContext<BuilderInvoicesStateModel>,
    action: UpdateInvoicePaymentMethod,
  ) {
    ctx.patchState({ paymentMethodSaveStatus: 'saving' });
    return this.api.setInvoicePaymentMethod(action.id, action.method).pipe(
      tap((invoice) => {
        const state = ctx.getState();
        ctx.patchState({
          selected:
            state.selected?.id === invoice.id ? invoice : state.selected,
          invoices: state.invoices.map((row) =>
            row.id === invoice.id ? invoice : row,
          ),
          paymentMethodSaveStatus: 'idle',
        });
      }),
      catchError(() => {
        ctx.patchState({ paymentMethodSaveStatus: 'error' });
        return of(null);
      }),
    );
  }

  @Action(ClearInvoicesState)
  clear(ctx: StateContext<BuilderInvoicesStateModel>) {
    ctx.setState(defaults);
  }
}

/**
 * Lazy provider for the `builder/invoices` route (via lazyProvider in
 * app.routes.ts): the invoices state — and the builder copy it reads —
 * stays out of the initial bundle.
 *
 * BUILDER_COPY must be registered in the SAME environment injector as the
 * state. lazyProvider instantiates the state in a child environment
 * injector, which cannot see component-level providers (e.g. the builder
 * shell's) — without this entry, inject(BUILDER_COPY) throws
 * NullInjectorError and the invoices tab lands on the error page.
 */
export const builderInvoicesStateProvider: EnvironmentProviders =
  makeEnvironmentProviders([provideBuilderCopy(), provideStates([BuilderInvoicesState])]);
