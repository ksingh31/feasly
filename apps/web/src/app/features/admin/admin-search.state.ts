import { inject, Injectable } from '@angular/core';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import { EMPTY, type Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { AdminSearchHit, AdminSearchResponse } from '@feasly/contracts';
import { AdminSearchApiService } from './admin-search-api.service';
import { ClearAdminSearch, SearchAdmin, type AdminSearchScope } from './admin-search.actions';

export type AdminSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface AdminSearchResult {
  readonly query: string;
  readonly hits: readonly AdminSearchHit[];
  readonly status: AdminSearchStatus;
  readonly error: string | null;
}

export type AdminSearchStateModel = Record<AdminSearchScope, AdminSearchResult>;

const EMPTY_RESULT: AdminSearchResult = { query: '', hits: [], status: 'idle', error: null };

/**
 * Admin global search state (#538). Memory-only (search hits name real
 * people — never persisted). `cancelUncompleted` gives switchMap
 * semantics: a newer keystroke's search drops the in-flight one, so a
 * stale response can never overwrite newer hits.
 */
@State<AdminSearchStateModel>({
  name: 'adminSearch',
  defaults: { palette: EMPTY_RESULT, leadPicker: EMPTY_RESULT },
})
@Injectable()
export class AdminSearchState {
  private readonly api = inject(AdminSearchApiService);

  @Selector()
  static palette(state: AdminSearchStateModel): AdminSearchResult {
    return state.palette;
  }

  @Selector()
  static leadPicker(state: AdminSearchStateModel): AdminSearchResult {
    return state.leadPicker;
  }

  @Action(SearchAdmin, { cancelUncompleted: true })
  search(
    ctx: StateContext<AdminSearchStateModel>,
    action: SearchAdmin,
  ): Observable<AdminSearchResponse> {
    const query = action.query.trim();
    if (!query) {
      ctx.patchState({ [action.scope]: EMPTY_RESULT });
      return EMPTY;
    }
    const previous = ctx.getState()[action.scope];
    ctx.patchState({
      [action.scope]: { query, hits: previous.hits, status: 'loading', error: null },
    });
    return this.api.search(query).pipe(
      tap({
        next: (response) =>
          ctx.patchState({
            [action.scope]: { query, hits: response.hits, status: 'ready', error: null },
          }),
        error: (err: { message?: string }) =>
          ctx.patchState({
            [action.scope]: {
              query,
              hits: [],
              status: 'error',
              error: err?.message ?? null,
            },
          }),
      }),
    );
  }

  @Action(ClearAdminSearch)
  clear(ctx: StateContext<AdminSearchStateModel>, action: ClearAdminSearch): void {
    ctx.patchState({ [action.scope]: EMPTY_RESULT });
  }
}

export const adminSearchStateProvider = provideStates([AdminSearchState]);
