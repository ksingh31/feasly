import { isPlatformServer } from '@angular/common';
import { inject, Injectable, PLATFORM_ID } from '@angular/core';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import { catchError, EMPTY, map, switchMap, tap } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  CommunityLivingResponse,
  CommunitySchoolDesignationsResponse,
  SchoolsListResponse,
  SchoolType,
} from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import {
  LoadCommunityLiving,
  LoadCommunitySchools,
  OpenCommunityGuide,
  SelectCommunityGuideTab,
  SetSchoolTypeFilter,
  type CommunityGuideTab,
} from './community-guide.actions';

export type CommunityGuideLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Schools-tab type filter: every type, or one school type. */
export type SchoolTypeFilter = 'all' | SchoolType;

/**
 * Community guide tabs state (#781): the active tab, the Schools type
 * filter, and the Schools / Living nearby data for the open community.
 *
 * Memory-only (never persisted) and lazy-provided at the community route.
 * Data comes from our own API (monthly-refreshed tables — a visitor never
 * triggers an outside call), fetched once per slug when its tab first opens.
 * Never fetched during prerender/SSR: the prerendered page carries the tab
 * shell and copy; the figures load after hydration.
 */
export interface CommunityGuideStateModel {
  readonly slug: string | null;
  readonly tab: CommunityGuideTab;
  readonly schoolTypeFilter: SchoolTypeFilter;
  readonly schoolsStatus: CommunityGuideLoadStatus;
  readonly designations: CommunitySchoolDesignationsResponse | null;
  readonly schools: SchoolsListResponse | null;
  readonly livingStatus: CommunityGuideLoadStatus;
  readonly living: CommunityLivingResponse | null;
}

const defaults: CommunityGuideStateModel = {
  slug: null,
  tab: 'overview',
  schoolTypeFilter: 'all',
  schoolsStatus: 'idle',
  designations: null,
  schools: null,
  livingStatus: 'idle',
  living: null,
};

@State<CommunityGuideStateModel>({ name: 'communityGuide', defaults })
@Injectable()
export class CommunityGuideState {
  private readonly api = inject(API_SERVICE);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));

  @Selector()
  static tab(state: CommunityGuideStateModel): CommunityGuideTab {
    return state.tab;
  }

  @Selector()
  static schoolTypeFilter(state: CommunityGuideStateModel): SchoolTypeFilter {
    return state.schoolTypeFilter;
  }

  @Selector()
  static schoolsStatus(state: CommunityGuideStateModel): CommunityGuideLoadStatus {
    return state.schoolsStatus;
  }

  @Selector()
  static designations(state: CommunityGuideStateModel): CommunitySchoolDesignationsResponse | null {
    return state.designations;
  }

  @Selector()
  static schools(state: CommunityGuideStateModel): SchoolsListResponse | null {
    return state.schools;
  }

  @Selector()
  static livingStatus(state: CommunityGuideStateModel): CommunityGuideLoadStatus {
    return state.livingStatus;
  }

  @Selector()
  static living(state: CommunityGuideStateModel): CommunityLivingResponse | null {
    return state.living;
  }

  @Action(OpenCommunityGuide)
  open(ctx: StateContext<CommunityGuideStateModel>, action: OpenCommunityGuide): void {
    if (ctx.getState().slug === action.slug) return;
    ctx.setState({ ...defaults, slug: action.slug });
  }

  @Action(SelectCommunityGuideTab)
  selectTab(ctx: StateContext<CommunityGuideStateModel>, action: SelectCommunityGuideTab): void {
    ctx.patchState({ tab: action.tab });
  }

  @Action(SetSchoolTypeFilter)
  setFilter(ctx: StateContext<CommunityGuideStateModel>, action: SetSchoolTypeFilter): void {
    ctx.patchState({ schoolTypeFilter: action.filter });
  }

  /**
   * Designations by slug first (they carry the City community code), then
   * the schools directory for that code. A failed request is not cached —
   * reopening the tab retries.
   */
  @Action(LoadCommunitySchools)
  loadSchools(ctx: StateContext<CommunityGuideStateModel>): Observable<unknown> | void {
    const { slug, schoolsStatus } = ctx.getState();
    if (this.isServer || !slug || schoolsStatus === 'loading' || schoolsStatus === 'ready') return;
    ctx.patchState({ schoolsStatus: 'loading' });
    return this.api.getCommunitySchoolDesignations(slug).pipe(
      switchMap((designations) =>
        this.api
          .listCommunitySchools(designations.communityCode)
          .pipe(map((schools) => ({ designations, schools }))),
      ),
      tap(({ designations, schools }) => {
        // Ignore a late answer for a community the visitor already left.
        if (ctx.getState().slug !== slug) return;
        ctx.patchState({ schoolsStatus: 'ready', designations, schools });
      }),
      catchError(() => {
        if (ctx.getState().slug === slug) ctx.patchState({ schoolsStatus: 'error' });
        return EMPTY;
      }),
    );
  }

  @Action(LoadCommunityLiving)
  loadLiving(ctx: StateContext<CommunityGuideStateModel>): Observable<unknown> | void {
    const { slug, livingStatus } = ctx.getState();
    if (this.isServer || !slug || livingStatus === 'loading' || livingStatus === 'ready') return;
    ctx.patchState({ livingStatus: 'loading' });
    return this.api.getCommunityLiving(slug).pipe(
      tap((living) => {
        if (ctx.getState().slug !== slug) return;
        ctx.patchState({ livingStatus: 'ready', living });
      }),
      catchError(() => {
        if (ctx.getState().slug === slug) ctx.patchState({ livingStatus: 'error' });
        return EMPTY;
      }),
    );
  }
}

export const communityGuideStateProvider = provideStates([CommunityGuideState]);
