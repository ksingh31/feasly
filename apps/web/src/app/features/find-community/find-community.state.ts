import { inject, Injectable, type EnvironmentProviders } from '@angular/core';
import { Action, provideStates, Selector, State, Store, type StateContext } from '@ngxs/store';
import { of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import type { CommunityMatchResponse, CommunityMatchResult } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config/config.service';
import {
  ClearMatchCompare,
  CycleMatchPriority,
  LoadCommunityMatches,
  SetMatchSelection,
  ToggleMatchCompare,
  ToggleMatchFilter,
} from './find-community.actions';
import {
  cyclePriority,
  EMPTY_SELECTION,
  toggleFilter,
  toMatchRequest,
  type MatchSelection,
} from './match-selection';

/**
 * The visitor's priorities + build filters (#779). Its own tiny state so the
 * storage plugin persists exactly this (string key
 * 'findCommunitySelection' in app.config.ts — must match the name) and
 * never the API response. No PII: priority keys only.
 */
export interface FindCommunitySelectionModel {
  selection: MatchSelection;
}

@State<FindCommunitySelectionModel>({
  name: 'findCommunitySelection',
  defaults: { selection: EMPTY_SELECTION },
})
@Injectable()
export class FindCommunitySelectionState {
  @Selector()
  static selection(state: FindCommunitySelectionModel): MatchSelection {
    return state.selection;
  }

  @Action(SetMatchSelection)
  set(ctx: StateContext<FindCommunitySelectionModel>, { selection }: SetMatchSelection): void {
    ctx.setState({ selection });
  }

  @Action(CycleMatchPriority)
  cycle(ctx: StateContext<FindCommunitySelectionModel>, { key }: CycleMatchPriority): void {
    ctx.setState({ selection: cyclePriority(ctx.getState().selection, key) });
  }

  @Action(ToggleMatchFilter)
  toggle(ctx: StateContext<FindCommunitySelectionModel>, { key }: ToggleMatchFilter): void {
    ctx.setState({ selection: toggleFilter(ctx.getState().selection, key) });
  }
}

export type MatchStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Ranking + compare tray (#779). Memory-only: the ranking is re-fetched
 * from the selection on every visit.
 */
export interface FindCommunityModel {
  status: MatchStatus;
  response: CommunityMatchResponse | null;
  /** Ticked communities, in tick order (snapshots, so a re-rank can't drop one). */
  compare: CommunityMatchResult[];
  /** True after a tick past the compare max was refused; cleared by the next change. */
  compareBlocked: boolean;
}

const defaults: FindCommunityModel = {
  status: 'idle',
  response: null,
  compare: [],
  compareBlocked: false,
};

@State<FindCommunityModel>({ name: 'findCommunity', defaults })
@Injectable()
export class FindCommunityState {
  private readonly api = inject(API_SERVICE);
  private readonly config = inject(ConfigService);
  private readonly store = inject(Store);

  @Selector()
  static status(state: FindCommunityModel): MatchStatus {
    return state.status;
  }

  @Selector()
  static response(state: FindCommunityModel): CommunityMatchResponse | null {
    return state.response;
  }

  @Selector()
  static compare(state: FindCommunityModel): readonly CommunityMatchResult[] {
    return state.compare;
  }

  @Selector()
  static compareBlocked(state: FindCommunityModel): boolean {
    return state.compareBlocked;
  }

  /**
   * One request per call; a newer call cancels an in-flight one so a slow
   * answer for old priorities never overwrites the current ranking.
   */
  @Action(LoadCommunityMatches, { cancelUncompleted: true })
  load(ctx: StateContext<FindCommunityModel>): Observable<void> {
    const selection = this.store.selectSnapshot(FindCommunitySelectionState.selection);
    const limits = this.config.get('limits');
    const request = toMatchRequest(selection, {
      wideLotFrontageFt: limits.communityMatchWideLotFrontageFt,
      limit: limits.communityMatchResultLimit,
    });
    if (request === null) {
      ctx.patchState({ status: 'idle', response: null });
      return of(undefined);
    }
    ctx.patchState({ status: 'loading' });
    return this.api.matchCommunities(request).pipe(
      map((response) => {
        // Refresh compare snapshots that are still in the ranking.
        const byCode = new Map(response.results.map((r) => [r.communityCode, r]));
        const compare = ctx.getState().compare.map((c) => byCode.get(c.communityCode) ?? c);
        ctx.patchState({ status: 'ready', response, compare });
      }),
      catchError(() => {
        ctx.patchState({ status: 'error' });
        return of(undefined);
      }),
    );
  }

  @Action(ToggleMatchCompare)
  toggleCompare(ctx: StateContext<FindCommunityModel>, { communityCode }: ToggleMatchCompare): void {
    const { compare, response } = ctx.getState();
    if (compare.some((c) => c.communityCode === communityCode)) {
      ctx.patchState({
        compare: compare.filter((c) => c.communityCode !== communityCode),
        compareBlocked: false,
      });
      return;
    }
    if (compare.length >= this.config.get('limits').communityMatchCompareMax) {
      ctx.patchState({ compareBlocked: true });
      return;
    }
    const result = response?.results.find((r) => r.communityCode === communityCode);
    if (!result) return;
    ctx.patchState({ compare: [...compare, result], compareBlocked: false });
  }

  @Action(ClearMatchCompare)
  clearCompare(ctx: StateContext<FindCommunityModel>): void {
    ctx.patchState({ compare: [], compareBlocked: false });
  }
}

/**
 * Lazy provider for `/find-a-community` (app.routes.ts lazyProvider): keeps
 * both states out of the initial bundle.
 */
export const findCommunityStateProvider: EnvironmentProviders = provideStates([
  FindCommunitySelectionState,
  FindCommunityState,
]);
