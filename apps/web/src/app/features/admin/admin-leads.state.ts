import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import { catchError, tap } from 'rxjs/operators';
import { EMPTY } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AdminLeadDetail,
  AdminLeadFilters,
  AdminLeadListItem,
  AdminLeadListResponse,
  AdminLeadStatus,
} from '@feasly/contracts';
import { AdminLeadsApiService } from './admin-leads-api.service';
import { ConfigService } from '../../core/config/config.service';
import {
  AddAdminLeadNote,
  ApproveQuarantinedLead,
  ClearSelectedAdminLead,
  DiscardQuarantinedLead,
  DismissAdminLeadNoteError,
  DismissAdminLeadStatusError,
  DismissAdminLeadStatusSuccess,
  DismissExportError,
  DismissQuarantineActionError,
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
  /** Pipeline totals: per-status counts for the filtered set (status filter excluded). */
  statusCounts: Record<AdminLeadStatus, number>;
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
  /** Last failed note-post message; null when the last note posted. */
  noteError: string | null;
  statusUpdating: boolean;
  /** Last failed status-update message; null when the last apply succeeded. */
  statusUpdateError: string | null;
  /** True after a status apply until dismissed (drives the inline confirmation). */
  statusUpdateSuccess: boolean;
  /** Last failed detail-refresh message; null when the last refresh succeeded. */
  detailRefreshError: string | null;
  exporting: boolean;
  /** Last failed CSV-export message; null when the last export succeeded. */
  exportError: string | null;
  /** Lead id with an in-flight quarantine approve/discard; null when idle. */
  quarantineActionId: string | null;
  /** Which quarantine action is in flight for `quarantineActionId`. */
  quarantineActionKind: 'approve' | 'discard' | null;
  /** Last failed quarantine-action message; null when the last one succeeded. */
  quarantineActionError: string | null;
}

const defaults: AdminLeadsStateModel = {
  leads: [],
  totalCount: 0,
  statusCounts: { new: 0, contacted: 0, quoting: 0, won: 0, lost: 0 },
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
  noteError: null,
  statusUpdating: false,
  statusUpdateError: null,
  statusUpdateSuccess: false,
  detailRefreshError: null,
  exporting: false,
  exportError: null,
  quarantineActionId: null,
  quarantineActionKind: null,
  quarantineActionError: null,
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
  private readonly config = inject(ConfigService);

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
  static statusCounts(state: AdminLeadsStateModel): Record<AdminLeadStatus, number> {
    return state.statusCounts;
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
  static noteError(state: AdminLeadsStateModel): string | null {
    return state.noteError;
  }

  @Selector()
  static statusUpdating(state: AdminLeadsStateModel): boolean {
    return state.statusUpdating;
  }

  @Selector()
  static statusUpdateError(state: AdminLeadsStateModel): string | null {
    return state.statusUpdateError;
  }

  @Selector()
  static statusUpdateSuccess(state: AdminLeadsStateModel): boolean {
    return state.statusUpdateSuccess;
  }

  @Selector()
  static detailRefreshError(state: AdminLeadsStateModel): string | null {
    return state.detailRefreshError;
  }

  @Selector()
  static exporting(state: AdminLeadsStateModel): boolean {
    return state.exporting;
  }

  @Selector()
  static exportError(state: AdminLeadsStateModel): string | null {
    return state.exportError;
  }

  @Selector()
  static quarantineActionId(state: AdminLeadsStateModel): string | null {
    return state.quarantineActionId;
  }

  @Selector()
  static quarantineActionKind(
    state: AdminLeadsStateModel,
  ): 'approve' | 'discard' | null {
    return state.quarantineActionKind;
  }

  @Selector()
  static quarantineActionError(state: AdminLeadsStateModel): string | null {
    return state.quarantineActionError;
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Merges tab/sandbox state into the effective backend filters.
   *
   * The quarantine tab forces `quarantinedOnly: true` so it lists only
   * honeypot-flagged rows (never the full lead list); everywhere else
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
      quarantinedOnly: tab === 'quarantine' ? true : undefined,
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
            statusCounts: res.statusCounts,
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
    const before = ctx.getState();
    // A re-select of the open lead (e.g. after apply-status / apply-builder /
    // add-note) is a refresh, not a fresh open: keep the stale detail on
    // screen so the modal doesn't flash through the loading state.
    const isRefresh = before.selectedLeadId === action.id && before.detail !== null;
    ctx.patchState({
      selectedLeadId: action.id,
      detail: isRefresh ? before.detail : null,
      detailStatus: 'loading',
      detailError: null,
      detailRefreshError: null,
      statusUpdateError: null,
      // A refresh keeps the success confirmation visible; a fresh selection
      // clears it.
      statusUpdateSuccess: isRefresh ? before.statusUpdateSuccess : false,
    });
    return this.api.getLead(action.id).pipe(
      tap({
        next: (detail) => {
          // Ignore a stale response if the user closed/changed selection.
          if (ctx.getState().selectedLeadId !== action.id) {
            return;
          }
          ctx.patchState({
            detail,
            detailStatus: 'idle',
            detailError: null,
            detailRefreshError: null,
          });
        },
        error: (err: { message?: string }) => {
          if (ctx.getState().selectedLeadId !== action.id) {
            return;
          }
          if (isRefresh) {
            // Keep the stale detail visible and surface the refresh failure
            // inline instead of wiping the modal.
            ctx.patchState({
              detailStatus: 'idle',
              detailRefreshError:
                err?.message ?? 'Could not refresh lead detail. Please try again.',
            });
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
      detailRefreshError: null,
      noteError: null,
      statusUpdateError: null,
      statusUpdateSuccess: false,
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
    ctx.patchState({ notePosting: true, noteError: null });
    return this.api.addNote(action.id, note).pipe(
      tap({
        next: () => {
          // Notes are append-only and server-owned — refetch the detail so
          // the thread reflects exactly what's stored.
          ctx.patchState({ notePosting: false, noteError: null });
          ctx.dispatch(new SelectAdminLead(action.id));
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            notePosting: false,
            noteError: err?.message ?? 'Could not add the note. Please try again.',
          });
        },
      }),
    );
  }

  @Action(UpdateAdminLeadStatus)
  updateStatus(
    ctx: StateContext<AdminLeadsStateModel>,
    action: UpdateAdminLeadStatus,
  ): Observable<unknown> {
    const state = ctx.getState();
    const row = state.leads.find((lead) => lead.id === action.id);
    const previousDetail = state.detail;
    const previousCounts = state.statusCounts;
    // The modal's detail is the freshest status; fall back to the row.
    const oldStatus: AdminLeadStatus =
      previousDetail && previousDetail.id === action.id
        ? previousDetail.status
        : (row?.status ?? action.status);

    // Optimistic update: the list row, modal badge, and pipeline totals
    // move instantly; the API call confirms or rolls back.
    const optimisticCounts: Record<AdminLeadStatus, number> = { ...previousCounts };
    if (oldStatus !== action.status) {
      optimisticCounts[oldStatus] = Math.max(0, optimisticCounts[oldStatus] - 1);
      optimisticCounts[action.status] = optimisticCounts[action.status] + 1;
    }
    ctx.patchState({
      statusUpdating: true,
      statusUpdateError: null,
      statusUpdateSuccess: false,
      leads: state.leads.map((lead) =>
        lead.id === action.id ? { ...lead, status: action.status } : lead,
      ),
      detail:
        previousDetail && previousDetail.id === action.id
          ? { ...previousDetail, status: action.status }
          : previousDetail,
      statusCounts: optimisticCounts,
    });

    return this.api.updateStatus(action.id, action.status).pipe(
      tap({
        next: () => {
          ctx.patchState({ statusUpdating: false, statusUpdateSuccess: true });
          // Refetch the detail for the fresh status history + audit trail.
          // The select is a refresh (same id), so the modal keeps its
          // content and the confirmation stays visible.
          ctx.dispatch(new SelectAdminLead(action.id));
        },
        error: (err: { message?: string }) => {
          // Roll back the optimistic update — the status never changed.
          const failed = ctx.getState();
          ctx.patchState({
            statusUpdating: false,
            statusUpdateError: err?.message ?? 'Could not update status. Please try again.',
            leads: failed.leads.map((lead) =>
              lead.id === action.id ? { ...lead, status: oldStatus } : lead,
            ),
            detail:
              failed.detail && failed.detail.id === action.id
                ? { ...failed.detail, status: oldStatus }
                : failed.detail,
            statusCounts: previousCounts,
          });
        },
      }),
    );
  }

  @Action(DismissAdminLeadStatusError)
  dismissStatusError(ctx: StateContext<AdminLeadsStateModel>): void {
    ctx.patchState({ statusUpdateError: null });
  }

  @Action(DismissAdminLeadStatusSuccess)
  dismissStatusSuccess(ctx: StateContext<AdminLeadsStateModel>): void {
    ctx.patchState({ statusUpdateSuccess: false });
  }

  @Action(DismissAdminLeadNoteError)
  dismissNoteError(ctx: StateContext<AdminLeadsStateModel>): void {
    ctx.patchState({ noteError: null });
  }

  @Action(ExportAdminLeadsCsv)
  exportCsv(ctx: StateContext<AdminLeadsStateModel>): Observable<Blob> | void {
    if (ctx.getState().exporting) {
      return;
    }
    const state = ctx.getState();
    const filters = this.effectiveFilters(state, state.filters, state.tab);
    ctx.patchState({ exporting: true, exportError: null });
    return this.api.exportCsv(filters).pipe(
      tap({
        next: (blob) => {
          ctx.patchState({ exporting: false });
          this.downloadBlob(blob, 'feasly-leads.csv');
        },
      }),
      // Swallow the error into user-facing state. Without this catchError the
      // ApiError propagates through the NGXS dispatch stream as an unhandled
      // error and lands the admin on the branded /error page (2026-09-27).
      catchError((err: { message?: string }) => {
        ctx.patchState({
          exporting: false,
          exportError: err?.message ?? 'Could not export the CSV. Please try again.',
        });
        return EMPTY;
      }),
    );
  }

  @Action(DismissExportError)
  dismissExportError(ctx: StateContext<AdminLeadsStateModel>): void {
    ctx.patchState({ exportError: null });
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

  @Action(ApproveQuarantinedLead)
  approveQuarantine(
    ctx: StateContext<AdminLeadsStateModel>,
    action: ApproveQuarantinedLead,
  ): Observable<unknown> | void {
    return this.runQuarantineAction(ctx, action.id, 'approve');
  }

  @Action(DiscardQuarantinedLead)
  discardQuarantine(
    ctx: StateContext<AdminLeadsStateModel>,
    action: DiscardQuarantinedLead,
  ): Observable<unknown> | void {
    return this.runQuarantineAction(ctx, action.id, 'discard');
  }

  @Action(DismissQuarantineActionError)
  dismissQuarantineActionError(ctx: StateContext<AdminLeadsStateModel>): void {
    ctx.patchState({ quarantineActionError: null });
  }

  /**
   * Shared quarantine approve/discard runner. On success the lead leaves
   * the quarantine tab either way (approved → back in the pipeline, no
   * longer matching `quarantinedOnly`; discarded → excluded from every
   * listing), so it is removed from the local list and the count
   * decrements — no refetch needed.
   */
  private runQuarantineAction(
    ctx: StateContext<AdminLeadsStateModel>,
    id: string,
    kind: 'approve' | 'discard',
  ): Observable<unknown> | void {
    if (ctx.getState().quarantineActionId !== null) {
      return;
    }
    ctx.patchState({
      quarantineActionId: id,
      quarantineActionKind: kind,
      quarantineActionError: null,
    });
    const call =
      kind === 'approve'
        ? this.api.approveQuarantine(id)
        : this.api.discardQuarantine(id);
    return call.pipe(
      tap({
        next: () => {
          const current = ctx.getState();
          const wasSelected = current.selectedLeadId === id;
          ctx.patchState({
            quarantineActionId: null,
            quarantineActionKind: null,
            quarantineActionError: null,
            leads: current.leads.filter((lead) => lead.id !== id),
            totalCount: Math.max(0, current.totalCount - 1),
            // The detail modal may be open on this lead — its quarantine
            // context just changed, so close it rather than show stale data.
            selectedLeadId: wasSelected ? null : current.selectedLeadId,
            detail: wasSelected ? null : current.detail,
            detailStatus: wasSelected ? 'idle' : current.detailStatus,
          });
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            quarantineActionId: null,
            quarantineActionKind: null,
            quarantineActionError:
              err?.message ?? 'Could not update the lead. Please try again.',
          });
        },
      }),
      // Swallow the error into user-facing state (same as the CSV export):
      // without this the ApiError propagates through the NGXS dispatch
      // stream as an unhandled error and lands the admin on the branded
      // /error page.
      catchError(() => EMPTY),
    );
  }

  // ------------------------------------------------------------------ download

  /**
   * Triggers a browser download for the exported CSV blob.
   *
   * The object URL is revoked on a delay, not synchronously: revoking it
   * in the same task as the programmatic click aborts the download in
   * Safari/WebKit (2026-09-28: Export CSV silently did nothing on iPhone).
   */
  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = this.document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    this.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Give the browser a task to start the download before the URL dies.
    const delayMs = this.config.get('api').downloadRevokeDelayMs;
    setTimeout(() => URL.revokeObjectURL(url), delayMs);
  }
}

/**
 * Route-level provider for the lazy `/admin` route.
 * Registered via `lazyProvider` in `app.routes.ts` with a dynamic import so
 * the state + its actions stay in the admin lazy chunk, out of the
 * initial bundle (790kB production budget).
 */
export const adminLeadsStateProvider = provideStates([AdminLeadsState]);
