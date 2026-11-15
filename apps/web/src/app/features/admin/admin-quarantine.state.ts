import { Injectable, inject } from '@angular/core';
import { Action, Selector, State, type StateContext, provideStates } from '@ngxs/store';
import { EMPTY, type Observable, catchError, from, map, mergeMap, of, tap, toArray } from 'rxjs';
import type { AdminLeadFilters, AdminLeadListItem, AdminLeadListResponse } from '@feasly/contracts';
import { ConfigService } from '@app/core/config/config.service';
import { AdminLeadsApiService } from './admin-leads-api.service';
import {
  DecideQuarantined,
  DismissQuarantineError,
  LoadMoreQuarantine,
  LoadQuarantine,
  type QuarantineDecision,
  RefreshQuarantineCount,
} from './admin-quarantine.actions';

export type QuarantineListStatus = 'idle' | 'loading' | 'loading-more' | 'error';

/** Outcome of the last approve/discard run (drives the toast + error copy). */
export interface QuarantineDecisionResult {
  decision: QuarantineDecision;
  /** Leads the run was asked to decide. */
  requested: number;
  /** Ids the backend accepted (removed from the queue). */
  succeeded: readonly string[];
  /** Ids that failed (still in the queue, still selectable). */
  failed: readonly string[];
}

export interface AdminQuarantineStateModel {
  leads: AdminLeadListItem[];
  /** Rows matching the current search. */
  totalCount: number;
  nextCursor: string | null;
  search: string;
  listStatus: QuarantineListStatus;
  listError: string | null;
  /**
   * Whole-queue size for the sidebar badge, independent of the page's
   * search. Null until first known.
   */
  queueCount: number | null;
  /** Ids with an approve/discard in flight. */
  busyIds: string[];
  busyDecision: QuarantineDecision | null;
  lastResult: QuarantineDecisionResult | null;
  /** Inline failure message for the last run; null when it fully succeeded. */
  actionError: string | null;
}

const defaults: AdminQuarantineStateModel = {
  leads: [],
  totalCount: 0,
  nextCursor: null,
  search: '',
  listStatus: 'idle',
  listError: null,
  queueCount: null,
  busyIds: [],
  busyDecision: null,
  lastResult: null,
  actionError: null,
};

/** Backend filters for the quarantine queue: only honeypot-flagged rows. */
export function quarantineFilters(search: string): AdminLeadFilters {
  const q = search.trim();
  return { includeQuarantined: true, quarantinedOnly: true, ...(q ? { search: q } : {}) };
}

/**
 * Admin Quarantine queue (#540) — honeypot-flagged leads, promoted from a
 * Leads tab to its own route. Memory-only (admin lead data is sensitive
 * and refetches cheaply).
 *
 * There is no bulk endpoint: a bulk decision is one call per lead, run
 * with bounded concurrency. Each lead succeeds or fails on its own —
 * successes leave the queue, failures stay so the admin can retry them.
 */
@State<AdminQuarantineStateModel>({ name: 'adminQuarantine', defaults })
@Injectable()
export class AdminQuarantineState {
  private readonly api = inject(AdminLeadsApiService);
  private readonly config = inject(ConfigService);
  private readonly copy = this.config.get('copy').admin.quarantine;

  @Selector()
  static leads(state: AdminQuarantineStateModel): AdminLeadListItem[] {
    return state.leads;
  }

  @Selector()
  static totalCount(state: AdminQuarantineStateModel): number {
    return state.totalCount;
  }

  @Selector()
  static hasMore(state: AdminQuarantineStateModel): boolean {
    return state.nextCursor !== null;
  }

  @Selector()
  static listStatus(state: AdminQuarantineStateModel): QuarantineListStatus {
    return state.listStatus;
  }

  @Selector()
  static listError(state: AdminQuarantineStateModel): string | null {
    return state.listError;
  }

  @Selector()
  static queueCount(state: AdminQuarantineStateModel): number | null {
    return state.queueCount;
  }

  @Selector()
  static busyIds(state: AdminQuarantineStateModel): string[] {
    return state.busyIds;
  }

  @Selector()
  static busyDecision(state: AdminQuarantineStateModel): QuarantineDecision | null {
    return state.busyDecision;
  }

  @Selector()
  static lastResult(state: AdminQuarantineStateModel): QuarantineDecisionResult | null {
    return state.lastResult;
  }

  @Selector()
  static actionError(state: AdminQuarantineStateModel): string | null {
    return state.actionError;
  }

  private loadPage(
    ctx: StateContext<AdminQuarantineStateModel>,
    cursor: string | null,
  ): Observable<AdminLeadListResponse> {
    const { search } = ctx.getState();
    const append = cursor !== null;
    ctx.patchState({ listStatus: append ? 'loading-more' : 'loading', listError: null });
    return this.api.listLeads(quarantineFilters(search), cursor).pipe(
      tap((res) => {
        const current = ctx.getState();
        ctx.patchState({
          leads: append ? [...current.leads, ...res.leads] : [...res.leads],
          totalCount: res.totalCount,
          nextCursor: res.nextCursor,
          listStatus: 'idle',
          listError: null,
          // An unsearched first page is the whole queue: refresh the badge.
          ...(search.trim() === '' ? { queueCount: res.totalCount } : {}),
        });
      }),
      catchError((err: { message?: string }) => {
        ctx.patchState({ listStatus: 'error', listError: err?.message ?? this.copy.loadError });
        return EMPTY;
      }),
    );
  }

  @Action(LoadQuarantine, { cancelUncompleted: true })
  load(ctx: StateContext<AdminQuarantineStateModel>, action: LoadQuarantine): Observable<unknown> {
    ctx.patchState({ search: action.search });
    return this.loadPage(ctx, null);
  }

  @Action(RefreshQuarantineCount)
  refreshCount(ctx: StateContext<AdminQuarantineStateModel>): Observable<unknown> {
    return this.api.listLeads(quarantineFilters(''), null, 1).pipe(
      tap((res) => ctx.patchState({ queueCount: res.totalCount })),
      catchError(() => EMPTY),
    );
  }

  @Action(LoadMoreQuarantine)
  loadMore(ctx: StateContext<AdminQuarantineStateModel>): Observable<unknown> | void {
    const state = ctx.getState();
    if (state.nextCursor === null || state.listStatus !== 'idle') return;
    return this.loadPage(ctx, state.nextCursor);
  }

  @Action(DecideQuarantined)
  decide(ctx: StateContext<AdminQuarantineStateModel>, action: DecideQuarantined): Observable<unknown> | void {
    const ids = [...new Set(action.ids)];
    // One decision run at a time: a second click can't double-submit.
    if (ids.length === 0 || ctx.getState().busyIds.length > 0) return;
    ctx.patchState({ busyIds: ids, busyDecision: action.decision, actionError: null, lastResult: null });

    const call = (id: string): Observable<unknown> =>
      action.decision === 'approve' ? this.api.approveQuarantine(id) : this.api.discardQuarantine(id);
    const concurrency = Math.max(1, this.config.get('admin').quarantine.bulkConcurrency);

    return from(ids).pipe(
      mergeMap(
        (id) =>
          call(id).pipe(
            map(() => ({ id, ok: true })),
            catchError(() => of({ id, ok: false })),
          ),
        concurrency,
      ),
      toArray(),
      tap((outcomes) => {
        const succeeded = outcomes.filter((o) => o.ok).map((o) => o.id);
        const failed = outcomes.filter((o) => !o.ok).map((o) => o.id);
        const done = new Set(succeeded);
        const current = ctx.getState();
        ctx.patchState({
          busyIds: [],
          busyDecision: null,
          leads: current.leads.filter((lead) => !done.has(lead.id)),
          totalCount: Math.max(0, current.totalCount - succeeded.length),
          queueCount: current.queueCount === null ? null : Math.max(0, current.queueCount - succeeded.length),
          lastResult: { decision: action.decision, requested: ids.length, succeeded, failed },
          actionError: failed.length === 0 ? null : this.failureMessage(failed.length, ids.length),
        });
      }),
    );
  }

  @Action(DismissQuarantineError)
  dismissError(ctx: StateContext<AdminQuarantineStateModel>): void {
    ctx.patchState({ actionError: null });
  }

  private failureMessage(failed: number, total: number): string {
    if (total === 1) return this.copy.failedOne;
    return this.copy.failedMany.replace('{failed}', String(failed)).replace('{total}', String(total));
  }
}

/** Route-level provider (registered on the lazy `/admin` parent for the badge). */
export const adminQuarantineStateProvider = provideStates([AdminQuarantineState]);
