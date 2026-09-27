import { inject, Injectable } from '@angular/core';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import type {
  DisputeDetailResponse,
  DisputeListItem,
  DisputeListResponse,
} from '@feasly/contracts';
import { AdminDisputesApiService } from './admin-disputes-api.service';
import {
  AcceptAdminDispute,
  ClearSelectedAdminDispute,
  DismissAdminDisputeResolution,
  LoadAdminDisputes,
  RejectAdminDispute,
  SelectAdminDispute,
  type AdminDisputeOutcome,
} from './admin-disputes.actions';

/** List loading lifecycle. */
export type AdminDisputesListStatus = 'idle' | 'loading' | 'error';

/** Detail-panel loading lifecycle. */
export type AdminDisputeDetailStatus = 'idle' | 'loading' | 'error';

/** The confirmation banner shown after a dispute is resolved. */
export interface AdminDisputeResolution {
  readonly disputeId: string;
  readonly outcome: AdminDisputeOutcome;
}

export interface AdminDisputesStateModel {
  /** Open disputes, oldest first (server-sorted). */
  disputes: DisputeListItem[];
  listStatus: AdminDisputesListStatus;
  listError: string | null;
  selectedDisputeId: string | null;
  detail: DisputeDetailResponse | null;
  detailStatus: AdminDisputeDetailStatus;
  detailError: string | null;
  /** An accept/reject is in flight. */
  resolving: boolean;
  resolveError: string | null;
  lastResolution: AdminDisputeResolution | null;
}

const defaults: AdminDisputesStateModel = {
  disputes: [],
  listStatus: 'idle',
  listError: null,
  selectedDisputeId: null,
  detail: null,
  detailStatus: 'idle',
  detailError: null,
  resolving: false,
  resolveError: null,
  lastResolution: null,
};

/**
 * Admin dispute-console state (billing/01 follow-on, was OPS-009).
 *
 * Memory-only — deliberately NOT registered with the storage plugin:
 * dispute data is sensitive and refetches cheaply on mount (same stance
 * as the calibration state).
 *
 * Action handlers RETURN their API observables (never bare `.subscribe()`):
 * NGXS then owns the subscription, so a newer `LoadAdminDisputes` cancels
 * an in-flight load and no stale response can overwrite a newer result.
 */
@State<AdminDisputesStateModel>({
  name: 'adminDisputes',
  defaults,
})
@Injectable()
export class AdminDisputesState {
  private readonly api = inject(AdminDisputesApiService);

  // ------------------------------------------------------------------ selectors

  @Selector()
  static disputes(state: AdminDisputesStateModel): DisputeListItem[] {
    return state.disputes;
  }

  @Selector()
  static listStatus(state: AdminDisputesStateModel): AdminDisputesListStatus {
    return state.listStatus;
  }

  @Selector()
  static listError(state: AdminDisputesStateModel): string | null {
    return state.listError;
  }

  @Selector()
  static selectedDisputeId(state: AdminDisputesStateModel): string | null {
    return state.selectedDisputeId;
  }

  @Selector()
  static detail(state: AdminDisputesStateModel): DisputeDetailResponse | null {
    return state.detail;
  }

  @Selector()
  static detailStatus(state: AdminDisputesStateModel): AdminDisputeDetailStatus {
    return state.detailStatus;
  }

  @Selector()
  static detailError(state: AdminDisputesStateModel): string | null {
    return state.detailError;
  }

  @Selector()
  static resolving(state: AdminDisputesStateModel): boolean {
    return state.resolving;
  }

  @Selector()
  static resolveError(state: AdminDisputesStateModel): string | null {
    return state.resolveError;
  }

  @Selector()
  static lastResolution(state: AdminDisputesStateModel): AdminDisputeResolution | null {
    return state.lastResolution;
  }

  // ------------------------------------------------------------------ actions

  @Action(LoadAdminDisputes)
  load(ctx: StateContext<AdminDisputesStateModel>): Observable<unknown> {
    ctx.patchState({ listStatus: 'loading', listError: null });
    return this.api.listDisputes().pipe(
      tap({
        next: (res: DisputeListResponse) => {
          ctx.patchState({
            disputes: [...res.disputes],
            listStatus: 'idle',
            listError: null,
          });
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            listStatus: 'error',
            listError: err?.message ?? 'Could not load disputes. Please try again.',
          });
        },
      }),
    );
  }

  @Action(SelectAdminDispute)
  select(
    ctx: StateContext<AdminDisputesStateModel>,
    action: SelectAdminDispute,
  ): Observable<unknown> {
    ctx.patchState({
      selectedDisputeId: action.id,
      detail: null,
      detailStatus: 'loading',
      detailError: null,
      // A new selection supersedes any earlier resolution banner/error.
      resolveError: null,
      lastResolution: null,
    });
    return this.api.getDispute(action.id).pipe(
      tap({
        next: (detail: DisputeDetailResponse) => {
          // Ignore a stale response if the user closed/changed selection.
          if (ctx.getState().selectedDisputeId !== action.id) {
            return;
          }
          ctx.patchState({ detail, detailStatus: 'idle', detailError: null });
        },
        error: (err: { message?: string }) => {
          if (ctx.getState().selectedDisputeId !== action.id) {
            return;
          }
          ctx.patchState({
            detailStatus: 'error',
            detailError: err?.message ?? 'Could not load dispute detail. Please try again.',
          });
        },
      }),
    );
  }

  @Action(ClearSelectedAdminDispute)
  clearSelection(ctx: StateContext<AdminDisputesStateModel>): void {
    ctx.patchState({
      selectedDisputeId: null,
      detail: null,
      detailStatus: 'idle',
      detailError: null,
      resolveError: null,
    });
  }

  @Action(AcceptAdminDispute)
  accept(
    ctx: StateContext<AdminDisputesStateModel>,
    action: AcceptAdminDispute,
  ): Observable<DisputeListItem> {
    return this.resolve(ctx, action.id, 'accepted', () =>
      this.api.acceptDispute(action.id, action.note),
    );
  }

  @Action(RejectAdminDispute)
  reject(
    ctx: StateContext<AdminDisputesStateModel>,
    action: RejectAdminDispute,
  ): Observable<DisputeListItem> {
    return this.resolve(ctx, action.id, 'rejected', () =>
      this.api.rejectDispute(action.id, action.note),
    );
  }

  @Action(DismissAdminDisputeResolution)
  dismissResolution(ctx: StateContext<AdminDisputesStateModel>): void {
    ctx.patchState({ lastResolution: null });
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Shared accept/reject path: one call, then the resolved dispute leaves
   * the open list (the backend no longer returns it) and a confirmation
   * banner replaces the detail panel.
   */
  private resolve(
    ctx: StateContext<AdminDisputesStateModel>,
    id: string,
    outcome: AdminDisputeOutcome,
    request: () => Observable<DisputeListItem>,
  ): Observable<DisputeListItem> {
    // NGXS dispatches are sequential, so resolves can't truly overlap; the
    // `resolving` flag exists for the UI (disable buttons while in flight).
    ctx.patchState({ resolving: true, resolveError: null });
    return request().pipe(
      tap({
        next: () => {
          const current = ctx.getState();
          ctx.patchState({
            disputes: current.disputes.filter((dispute) => dispute.id !== id),
            selectedDisputeId: null,
            detail: null,
            detailStatus: 'idle',
            detailError: null,
            resolving: false,
            resolveError: null,
            lastResolution: { disputeId: id, outcome },
          });
        },
        error: (err: { message?: string }) => {
          ctx.patchState({
            resolving: false,
            resolveError: err?.message ?? 'Could not resolve the dispute. Please try again.',
          });
        },
      }),
    );
  }
}

/**
 * Route-level provider for the lazy `/admin` route.
 * Registered via `lazyProvider` in `app.routes.ts` with a dynamic import so
 * the state + its actions stay in the admin lazy chunk, out of the
 * initial bundle (790kB production budget).
 */
export const adminDisputesStateProvider = provideStates([AdminDisputesState]);
