import { Injectable } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import {
  ClearProfilePropertyContext,
  SetProfilePropertyContext,
  type ProfilePropertyContext,
} from './community-profile.actions';

export interface CommunityProfileStateModel {
  /**
   * The rejected property's context, set just before navigating to a
   * community profile from the estimator's coverage gate. Null on direct
   * URL visits (or after refresh) — the profile then shows only the
   * community average, never an empty row.
   */
  readonly propertyContext: ProfilePropertyContext | null;
}

/** The storage-plugin key for this state (mirrors the @State name). */
export const CommunityProfileStateName = 'communityProfile';

/**
 * Transient community-profile context (estimator coverage redirect).
 * Deliberately NOT persisted via the storage plugin: the property context
 * is navigation-scoped, and a refresh should behave like a direct URL
 * visit (community average only).
 */
@State<CommunityProfileStateModel>({
  name: CommunityProfileStateName,
  defaults: {
    propertyContext: null,
  },
})
@Injectable()
export class CommunityProfileState {
  @Selector()
  static propertyContext(state: CommunityProfileStateModel): ProfilePropertyContext | null {
    return state.propertyContext;
  }

  @Action(SetProfilePropertyContext)
  setContext(
    ctx: StateContext<CommunityProfileStateModel>,
    action: SetProfilePropertyContext,
  ): void {
    ctx.patchState({ propertyContext: action.context });
  }

  @Action(ClearProfilePropertyContext)
  clearContext(ctx: StateContext<CommunityProfileStateModel>): void {
    ctx.patchState({ propertyContext: null });
  }
}
