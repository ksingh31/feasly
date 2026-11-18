import { Injectable } from '@angular/core';
import { Action, Selector, State, StateContext, provideStates } from '@ngxs/store';
import { ClearSchoolComparison, ToggleSchoolComparison } from './school-comparison.actions';

/**
 * Schools a visitor has lined up to compare (#781 "Add to school
 * comparison"; the compare view is #782). Persisted by the storage plugin
 * under the state name (`schoolComparison` in app.config.ts) so the list
 * survives navigating between community guides. Holds directory ids only.
 *
 * Lazy-provided (`schoolComparisonStateProvider`) at the routes that use it
 * so the state stays out of the initial bundle.
 */
export interface SchoolComparisonStateModel {
  readonly schoolIds: readonly string[];
}

export const SCHOOL_COMPARISON_STATE_NAME = 'schoolComparison';

@State<SchoolComparisonStateModel>({
  name: SCHOOL_COMPARISON_STATE_NAME,
  defaults: { schoolIds: [] },
})
@Injectable()
export class SchoolComparisonState {
  @Selector()
  static schoolIds(state: SchoolComparisonStateModel): readonly string[] {
    return state.schoolIds;
  }

  /** Adds the school, or removes it when already listed. Never grows past `max`. */
  @Action(ToggleSchoolComparison)
  toggle(ctx: StateContext<SchoolComparisonStateModel>, action: ToggleSchoolComparison): void {
    const ids = ctx.getState().schoolIds;
    if (ids.includes(action.schoolId)) {
      ctx.setState({ schoolIds: ids.filter((id) => id !== action.schoolId) });
      return;
    }
    if (ids.length >= action.max) return;
    ctx.setState({ schoolIds: [...ids, action.schoolId] });
  }

  @Action(ClearSchoolComparison)
  clear(ctx: StateContext<SchoolComparisonStateModel>): void {
    ctx.setState({ schoolIds: [] });
  }
}

export const schoolComparisonStateProvider = provideStates([SchoolComparisonState]);
