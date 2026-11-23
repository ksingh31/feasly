import { inject, Injectable } from '@angular/core';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import { catchError, of, tap } from 'rxjs';
import type {
  AdminCommunityNarrativeEntry,
  AdminCommunityNarrativeRegenerateResponse,
} from '@feasly/contracts';
import { AdminOpsApiService } from './admin-ops-api.service';
import {
  LoadCommunityNarratives,
  RegenerateCommunityNarratives,
} from './community-narratives.actions';

export type CommunityNarrativesLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** What is regenerating: one community's slug, or every community. */
export type CommunityNarrativesTarget = { readonly scope: 'one'; readonly slug: string } | { readonly scope: 'all' };

export interface CommunityNarrativesStateModel {
  communities: readonly AdminCommunityNarrativeEntry[] | null;
  loadStatus: CommunityNarrativesLoadStatus;
  /** Load failure message. The raw error never reaches the UI. */
  error: string | null;
  /** The regenerate request awaiting a response, or null. */
  regenerating: CommunityNarrativesTarget | null;
  /** Counts from the last regenerate, with the community it ran for. */
  lastResult: {
    readonly response: AdminCommunityNarrativeRegenerateResponse;
    readonly slug: string | null;
  } | null;
  /** Regenerate failure message. */
  regenerateError: string | null;
}

const defaults: CommunityNarrativesStateModel = {
  communities: null,
  loadStatus: 'idle',
  error: null,
  regenerating: null,
  lastResult: null,
  regenerateError: null,
};

/**
 * Community narratives ops state (#915): the single source of truth for
 * `/admin/ops/community-narratives`.
 *
 * Handlers return their API observables so NGXS owns the subscription.
 * After a regenerate resolves, the list reloads so the rows show the new
 * status. Memory-only: never added to the storage plugin.
 */
@State<CommunityNarrativesStateModel>({
  name: 'communityNarratives',
  defaults,
})
@Injectable()
export class CommunityNarrativesState {
  private readonly api = inject(AdminOpsApiService);

  @Selector()
  static communities(state: CommunityNarrativesStateModel): readonly AdminCommunityNarrativeEntry[] | null {
    return state.communities;
  }

  @Selector()
  static loadStatus(state: CommunityNarrativesStateModel): CommunityNarrativesLoadStatus {
    return state.loadStatus;
  }

  @Selector()
  static error(state: CommunityNarrativesStateModel): string | null {
    return state.error;
  }

  @Selector()
  static regenerating(state: CommunityNarrativesStateModel): CommunityNarrativesTarget | null {
    return state.regenerating;
  }

  @Selector()
  static lastResult(state: CommunityNarrativesStateModel): CommunityNarrativesStateModel['lastResult'] {
    return state.lastResult;
  }

  @Selector()
  static regenerateError(state: CommunityNarrativesStateModel): string | null {
    return state.regenerateError;
  }

  @Action(LoadCommunityNarratives, { cancelUncompleted: true })
  load(ctx: StateContext<CommunityNarrativesStateModel>) {
    ctx.patchState({ loadStatus: 'loading', error: null });
    return this.api.getCommunityNarratives().pipe(
      tap((res) => ctx.patchState({ communities: res.communities, loadStatus: 'ready' })),
      catchError(() => {
        ctx.patchState({
          loadStatus: 'error',
          error: 'Could not load the narratives. Try again.',
        });
        return of(null);
      }),
    );
  }

  @Action(RegenerateCommunityNarratives)
  regenerate(ctx: StateContext<CommunityNarrativesStateModel>, action: RegenerateCommunityNarratives) {
    if (ctx.getState().regenerating) {
      return of(null);
    }
    const slug = action.communitySlug ?? null;
    ctx.patchState({
      regenerating: slug ? { scope: 'one', slug } : { scope: 'all' },
      regenerateError: null,
    });
    return this.api
      .regenerateCommunityNarratives(slug ? { community_slug: slug } : {})
      .pipe(
        tap((response) => {
          ctx.patchState({ regenerating: null, lastResult: { response, slug } });
          ctx.dispatch(new LoadCommunityNarratives());
        }),
        catchError(() => {
          ctx.patchState({
            regenerating: null,
            regenerateError: 'Could not regenerate the narratives. Try again.',
          });
          return of(null);
        }),
      );
  }
}

/** Route-level provider, registered via `lazyProvider` in `app.routes.ts`. */
export const communityNarrativesStateProvider = provideStates([CommunityNarrativesState]);
