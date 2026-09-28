import { inject, Injectable } from '@angular/core';
import { of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import type { CommissionInvoice } from '@feasly/contracts';
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
  /** Total invoice count across all pages. */
  total: number;
  /** 1-based current page. */
  page: number;
  pageSize: number;
  listStatus: InvoicesStatus;
  /** Selected invoice for the detail view; null when closed. */
  selected: CommissionInvoice | null;
  detailStatus: InvoicesStatus;
}

const PAGE_SIZE = 10;

const defaults: BuilderInvoicesStateModel = {
  invoices: [],
  total: 0,
  page: 1,
  pageSize: PAGE_SIZE,
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
export class BuilderInvoicesState {
  private readonly api = inject(BuilderInvoicesApiService);

  @Selector()
  static invoices(state: BuilderInvoicesStateModel): readonly CommissionInvoice[] {
    return state.invoices;
  }

  @Selector()
  static total(state: BuilderInvoicesStateModel): number {
    return state.total;
  }

  @Selector()
  static page(state: BuilderInvoicesStateModel): number {
    return state.page;
  }

  @Selector()
  static totalPages(state: BuilderInvoicesStateModel): number {
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
    const page = Math.max(1, action.page);
    ctx.patchState({ listStatus: 'loading', page });
    return this.api.listInvoices(page, ctx.getState().pageSize).pipe(
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
