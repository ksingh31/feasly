import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import type {
  AdminLeadDetail,
  AdminLeadFilters,
  AdminLeadListItem,
  AdminLeadListResponse,
  AdminLeadStatus,
} from '@feasly/contracts';
import { AdminLeadsApiService } from './admin-leads-api.service';
import {
  AddAdminLeadNote,
  ClearSelectedAdminLead,
  ExportAdminLeadsCsv,
  LoadAdminLeads,
  LoadMoreAdminLeads,
  SelectAdminLead,
  SetAdminLeadsTab,
  ToggleAdminLeadsSandbox,
  UpdateAdminLeadStatus,
  type AdminLeadsTab,
} from './admin-leads.actions';

/** List loading lifecycle. */
export type AdminLeadsListStatus = 'idle' | 'loading' | 'loading-more' | 'error';

/** Detail-drawer loading lifecycle. */
export type AdminLeadDetailStatus = 'idle' | 'loading' | 'error';

export interface AdminLeadsStateModel {
  /** Current page rows (appended by LoadMore). */
  leads: AdminLeadListItem[];
  /** Total rows matching the filters (excludes sandbox unless toggled). */
  totalCount: number;
  /** Opaque cursor for the next page; null when this is the last page. */
  nextCursor: string | null;
  /** Active filter values (drives the filter form). */
  filters: AdminLeadFilters;
  tab: AdminLeadsTab;
  includeSandbox: boolean;
  listStatus: AdminLeadsListStatus;
  listError: string | null;
  selectedLeadId: string | null;
  detail: AdminLeadDetail | null;
  detailStatus: AdminLeadDetailStatus;
  detailError: string | null;
  notePosting: boolean;
  statusUpdating: boolean;
  exporting: boolean;
}

const defaults: AdminLeadsStateModel = {
  leads: [],
  totalCount: 0,
  nextCursor: null,
  filters: {},
  tab: 'all',
  includeSandbox: false,
  listStatus: 'idle',
  listError: null,
  selectedLeadId: null,
  detail: null,
  detailStatus: 'idle',
  detailError: null,
  notePosting: false,
  statusUpdating: false,
  exporting: false,
};

/**
 * Admin leads-explorer state (admin/02).
 *
 * Memory-only — deliberately NOT registered with the storage plugin:
 * admin lead data is sensitive and refetches cheaply on mount.
 *
 * Action handlers RETURN their API observables (never bare `.subscribe()`):
 * NGXS then owns the subscription, so a newer `LoadAdminLeads` cancels an
 * in-flight load and no stale response can overwrite a newer result.
 */
@State<AdminLeadsStateModel>({
  name: 'adminLeads',
  defaults,
})
@Injectable()
export class AdminLeadsState {
  private readonly api = inject(AdminLeadsApiService);
  private readonly document = inject(DOCUMENT);

  // ------------------------------------------------------------------ selectors

  @Selector()
  static leads(state: AdminLeadsStateModel): AdminLeadListItem[] {
    return state.leads;
  }

  @Selector()
  static totalCount(state: AdminLeadsStateModel): number {
    return state.totalCount;
  }

  @Selector()
  static hasMore(state: AdminLeadsStateModel): boolean {
    return state.nextCursor !== null;
  }

  @Selector()
  static filters(state: AdminLeadsStateModel): AdminLeadFilters {
    return state.filters;
  }

  @Selector()
  static tab(state: AdminLeadsStateModel): AdminLeadsTab {
    return state.tab;
  }

  @Selector()
  static includeSandbox(state: AdminLeadsStateModel): boolean {
    return state.includeSandbox;
  }

  @Selector()
  static listStatus(state: AdminLeadsStateModel): AdminLeadsListStatus {
    return state.listStatus;
  }

  @Selector()
  static listError(state: AdminLeadsStateModel): string | null {
    return state.listError;
  }

  @Selector()
  static selectedLeadId(state: AdminLeadsStateModel): string | null {
    return state.selectedLeadId;
  }

  @Selector()
  static detail(state: AdminLeadsStateModel): AdminLeadDetail | null {
    return state.detail;
  }

  @Selector()
  static detailStatus(state: AdminLeadsStateModel): AdminLeadDetailStatus {
    return state.detailStatus;
  }

  @Selector()
  static detailError(state: AdminLeadsStateModel): string | null {
    return state.detailError;
  }

  @Selector()
  static notePosting(state: AdminLeadsStateModel): boolean {
    return state.notePosting;
  }

  @Selector()
  static statusUpdating(state: AdminLeadsStateModel): boolean {
    return state.statusUpdating;
  }

  @Selector()
  static exporting(state: AdminLeadsStateModel): boolean {
    return state.exporting;
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Merges tab/sandbox state into the effective backend filters.
   *
   * The quarantine tab forces `includeQuarantined: true`; everywhere else
   * quarantined rows stay hidden. Sandbox rows are excluded unless the
   * admin toggles them in (they're badged "Sandbox" in the table).
   */
  private effectiveFilters(
    state: AdminLeadsStateModel,
    filters: AdminLeadFilters,
    tab: AdminLeadsTab,
  ): AdminLeadFilters {
    return {
      ...filters,
      includeQuarantined: tab === 'quarantine' ? true : undefined,
      includeSandbox: state.includeSandbox ? true : undefined,
    };
  }

  private loadPage(
    ctx: StateContext<AdminLeadsStateModel>,
    cursor: string | null,
    append: boolean,
  ): Observable<AdminLeadListResponse> {
    const state = ctx.getState();
    const filters = this.effectiveFilters(state, state.filters, state.tab);
    ctx.patchState({ listStatus: append ? 'loading-more' : 'loading', listError: null });
    return this.api.listLeads(filters, cursor).pipe(
      tap({
        next: (res) => {
          ctx.patchState({
            leads: append ? [...ctx.getState().leads, ...res.leads] : [...res.leads],
            totalCount: res.totalCount,
            nextCursor: res.nextCursor,
            listStatus: 'idle',
            listError: null,
          });
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            listStatus: 'error',
            listError: err?.message ?? 'Could not load leads. Please try again.',
          });
        },
      }),
    );
  }

  // ------------------------------------------------------------------ actions

  @Action(LoadAdminLeads)
  load(
    ctx: StateContext<AdminLeadsStateModel>,
    action: LoadAdminLeads,
  ): Observable<AdminLeadListResponse> {
    ctx.patchState({
      filters: { ...action.filters },
      tab: action.tab,
      // A fresh load clears any open detail — its filters may no longer match.
      selectedLeadId: null,
      detail: null,
      detailStatus: 'idle',
      detailError: null,
    });
    return this.loadPage(ctx, null, false);
  }

  @Action(LoadMoreAdminLeads)
  loadMore(ctx: StateContext<AdminLeadsStateModel>): Observable<AdminLeadListResponse> | void {
    const state = ctx.getState();
    if (state.nextCursor === null || state.listStatus !== 'idle') {
      return;
    }
    return this.loadPage(ctx, state.nextCursor, true);
  }

  @Action(SelectAdminLead)
  select(
    ctx: StateContext<AdminLeadsStateModel>,
    action: SelectAdminLead,
  ): Observable<AdminLeadDetail> {
    ctx.patchState({
      selectedLeadId: action.id,
      detail: null,
      detailStatus: 'loading',
      detailError: null,
    });
    return this.api.getLead(action.id).pipe(
      tap({
        next: (detail) => {
          // Ignore a stale response if the user closed/changed selection.
          if (ctx.getState().selectedLeadId !== action.id) {
            return;
          }
          ctx.patchState({ detail, detailStatus: 'idle', detailError: null });
        },
        error: (err: { message?: string }) => {
          if (ctx.getState().selectedLeadId !== action.id) {
            return;
          }
          ctx.patchState({
            detailStatus: 'error',
            detailError: err?.message ?? 'Could not load lead detail. Please try again.',
          });
        },
      }),
    );
  }

  @Action(ClearSelectedAdminLead)
  clearSelection(ctx: StateContext<AdminLeadsStateModel>): void {
    ctx.patchState({
      selectedLeadId: null,
      detail: null,
      detailStatus: 'idle',
      detailError: null,
    });
  }

  @Action(AddAdminLeadNote)
  addNote(
    ctx: StateContext<AdminLeadsStateModel>,
    action: AddAdminLeadNote,
  ): Observable<unknown> | void {
    const note = action.note.trim();
    if (note.length === 0) {
      return;
    }
    ctx.patchState({ notePosting: true });
    return this.api.addNote(action.id, note).pipe(
      tap({
        next: () => {
          // Notes are append-only and server-owned — refetch the detail so
          // the thread reflects exactly what's stored.
          ctx.patchState({ notePosting: false });
          ctx.dispatch(new SelectAdminLead(action.id));
        },
        error: () => {
          ctx.patchState({ notePosting: false });
        },
      }),
    );
  }

  @Action(UpdateAdminLeadStatus)
  updateStatus(
    ctx: StateContext<AdminLeadsStateModel>,
    action: UpdateAdminLeadStatus,
  ): Observable<unknown> {
    ctx.patchState({ statusUpdating: true });
    return this.api.updateStatus(action.id, action.status).pipe(
      tap({
        next: () => {
          // Keep the table row in sync without a full refetch, then reload
          // the detail for the fresh status history.
          const state = ctx.getState();
          const newStatus: AdminLeadStatus = action.status;
          ctx.patchState({
            leads: state.leads.map((lead) =>
              lead.id === action.id ? { ...lead, status: newStatus } : lead,
            ),
            statusUpdating: false,
          });
          ctx.dispatch(new SelectAdminLead(action.id));
        },
        error: () => {
          ctx.patchState({ statusUpdating: false });
        },
      }),
    );
  }

  @Action(ExportAdminLeadsCsv)
  exportCsv(ctx: StateContext<AdminLeadsStateModel>): Observable<Blob> | void {
    if (ctx.getState().exporting) {
      return;
    }
    const state = ctx.getState();
    const filters = this.effectiveFilters(state, state.filters, state.tab);
    ctx.patchState({ exporting: true });
    return this.api.exportCsv(filters).pipe(
      tap({
        next: (blob) => {
          ctx.patchState({ exporting: false });
          this.downloadBlob(blob, 'feasly-leads.csv');
        },
        error: () => {
          ctx.patchState({ exporting: false });
        },
      }),
    );
  }

  @Action(SetAdminLeadsTab)
  setTab(
    ctx: StateContext<AdminLeadsStateModel>,
    action: SetAdminLeadsTab,
  ): Observable<AdminLeadListResponse> | void {
    if (ctx.getState().tab === action.tab) {
      return;
    }
    ctx.patchState({
      tab: action.tab,
      selectedLeadId: null,
      detail: null,
      detailStatus: 'idle',
      detailError: null,
    });
    return this.loadPage(ctx, null, false);
  }

  @Action(ToggleAdminLeadsSandbox)
  toggleSandbox(
    ctx: StateContext<AdminLeadsStateModel>,
    action: ToggleAdminLeadsSandbox,
  ): Observable<AdminLeadListResponse> | void {
    if (ctx.getState().includeSandbox === action.include) {
      return;
    }
    ctx.patchState({ includeSandbox: action.include });
    return this.loadPage(ctx, null, false);
  }

  // ------------------------------------------------------------------ download

  /** Triggers a browser download for the exported CSV blob. */
  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    try {
      const anchor = this.document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = 'noopener';
      this.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
