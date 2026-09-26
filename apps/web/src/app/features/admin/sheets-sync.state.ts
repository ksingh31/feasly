import { inject, Injectable } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { catchError, of, tap } from 'rxjs';
import type {
  SheetsSyncBadge,
  SheetsSyncNowResponse,
  SheetsSyncStatusResponse,
} from '@feasly/contracts';
import { AdminOpsApiService } from './admin-ops-api.service';
import { LoadSheetsSyncStatus, TriggerSheetsSyncNow } from './sheets-sync.actions';

/** Loading lifecycle for the Sheets sync ops panel. */
export type SheetsSyncLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SheetsSyncStateModel {
  /** The latest status payload, or null before the first load. */
  status: SheetsSyncStatusResponse | null;
  /** Load/trigger lifecycle. */
  loadStatus: SheetsSyncLoadStatus;
  /** True while a manual "Sync now" request is awaiting a response. */
  triggering: boolean;
  /** Outcome of the last manual run (synced/skipped counts). */
  lastTrigger: SheetsSyncNowResponse | null;
  /** Load failure flag. The raw error never reaches the UI. */
  error: string | null;
}

const defaults: SheetsSyncStateModel = {
  status: null,
  loadStatus: 'idle',
  triggering: false,
  lastTrigger: null,
  error: null,
};

/**
 * Derive the panel badge from the status payload (admin/05 AC2 — the same
 * thresholds the backend documents; the backend's `lagging` flag already
 * folds the 2h rule in).
 *
 * - 'failing' when consecutive_failures >= 3
 * - 'lagging' when the sync is lagging (no success in the last 2h)
 * - 'healthy' otherwise
 */
export function sheetsSyncBadgeFor(
  status: SheetsSyncStatusResponse | null,
): SheetsSyncBadge | null {
  if (!status) return null;
  if (status.consecutive_failures >= 3) return 'failing';
  if (status.lagging) return 'lagging';
  return 'healthy';
}

/**
 * Sheets sync ops state (admin/05): the single source of truth for the
 * /admin/ops/sheets panel.
 *
 * Action handlers RETURN their API observables (never bare `.subscribe()`):
 * NGXS then owns the subscription, so a newer `LoadSheetsSyncStatus`
 * cancels an in-flight load and no stale response can overwrite a newer
 * one. After a manual trigger resolves, the status reloads so the panel
 * reflects the just-completed run.
 *
 * Memory-only: never added to the storage plugin (ops data goes stale).
 */
@State<SheetsSyncStateModel>({
  name: 'sheetsSync',
  defaults,
})
@Injectable()
export class SheetsSyncState {
  private readonly api = inject(AdminOpsApiService);

  @Selector()
  static status(state: SheetsSyncStateModel): SheetsSyncStatusResponse | null {
    return state.status;
  }

  @Selector()
  static badge(state: SheetsSyncStateModel): SheetsSyncBadge | null {
    return sheetsSyncBadgeFor(state.status);
  }

  @Selector()
  static loadStatus(state: SheetsSyncStateModel): SheetsSyncLoadStatus {
    return state.loadStatus;
  }

  @Selector()
  static triggering(state: SheetsSyncStateModel): boolean {
    return state.triggering;
  }

  @Selector()
  static lastTrigger(state: SheetsSyncStateModel): SheetsSyncNowResponse | null {
    return state.lastTrigger;
  }

  @Selector()
  static error(state: SheetsSyncStateModel): string | null {
    return state.error;
  }

  /** "Sync now" is disabled while a trigger is pending or a run is in flight. */
  @Selector()
  static syncNowDisabled(state: SheetsSyncStateModel): boolean {
    return state.triggering || state.status?.run_in_flight === true;
  }

  @Action(LoadSheetsSyncStatus)
  loadStatusAction(ctx: StateContext<SheetsSyncStateModel>) {
    ctx.patchState({ loadStatus: 'loading', error: null });
    return this.api.getSheetsStatus().pipe(
      tap((status) =>
        ctx.patchState({ status, loadStatus: 'ready', error: null }),
      ),
      catchError(() => {
        ctx.patchState({
          loadStatus: 'error',
          error: 'Could not load the Sheets sync status. Try again.',
        });
        return of(null);
      }),
    );
  }

  @Action(TriggerSheetsSyncNow)
  triggerSyncNow(ctx: StateContext<SheetsSyncStateModel>) {
    const { triggering, status } = ctx.getState();
    if (triggering || status?.run_in_flight === true) {
      return of(null);
    }
    ctx.patchState({ triggering: true, error: null });
    return this.api.triggerSheetsSyncNow().pipe(
      tap((result) => {
        ctx.patchState({ triggering: false, lastTrigger: result });
        // A 409 surfaces through the error path below; success reloads.
        ctx.dispatch(new LoadSheetsSyncStatus());
      }),
      catchError((error: { code?: string }) => {
        ctx.patchState({ triggering: false });
        // toApiError maps HTTP failures to ApiError{ code } — the sync-now
        // route answers 409 with code CONFLICT when a run is in flight.
        if (error?.code === 'CONFLICT' || error?.code === 'http_409') {
          // A run started (or was already) in flight — reload the status so
          // the panel shows it. The notice survives until the reload lands,
          // at which point run_in_flight tells the story itself.
          ctx.dispatch(new LoadSheetsSyncStatus());
          ctx.patchState({
            error: 'A sync run is already in flight.',
          });
        } else {
          ctx.patchState({
            error: 'Could not start the sync run. Try again.',
          });
        }
        return of(null);
      }),
    );
  }
}
