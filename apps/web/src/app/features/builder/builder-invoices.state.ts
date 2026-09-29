import { inject, Injectable } from '@angular/core';
import { of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { Action, NgxsOnInit, provideStates, Selector, State, StateContext } from '@ngxs/store';
import type { CommissionInvoice } from '@feasly/contracts';
import { BUILDER_COPY } from './builder-copy';
import {
  BuilderInvoicesApiService,
  type InvoiceListResponse,
} from './builder-invoices-api.service';
import {
  ClearInvoicesState,
  ClearInvoiceSelection,
  LoadInvoices,
  SelectInvoice,
} from './builder-invoices.actions';

/** Loading lifecycle for the invoice list / detail. */
export type InvoicesStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface BuilderInvoicesStateModel {
  /** Current page of invoices, newest first. Memory-only. */
  invoices: readonly CommissionInvoice[];
  /** Total invoice count across all pages; null when the backend reports none. */
  total: number | null;
  /** 1-based current page. */
  page: number;
  pageSize: number;
  listStatus: InvoicesStatus;
  /** Selected invoice for the detail view; null when closed. */
  selected: CommissionInvoice | null;
  detailStatus: InvoicesStatus;
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
  static invoices(state: BuilderInvoicesStateModel): readonly CommissionInvoice[] {
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
  static selected(state: BuilderInvoicesStateModel): CommissionInvoice | null {
    return state.selected;
  }

  @Selector()
  static detailStatus(state: BuilderInvoicesStateModel): InvoicesStatus {
    return state.detailStatus;
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
    return this.api.listInvoices(page, pageSize).pipe(
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

  @Action(ClearInvoicesState)
  clear(ctx: StateContext<BuilderInvoicesStateModel>) {
    ctx.setState(defaults);
  }
}

/**
 * Lazy provider for the `builder/invoices` route (via lazyProvider in
 * app.routes.ts): the invoices state — and the builder copy it reads —
 * stays out of the initial bundle.
 */
export const builderInvoicesStateProvider = provideStates([BuilderInvoicesState]);
