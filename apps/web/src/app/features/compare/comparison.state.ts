import { inject, Injectable } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { Action, Selector, State, StateContext, Store } from '@ngxs/store';
import type { ComparisonEstimateResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import type { CommunityStats } from '../../core/api/api.service';
import { WizardState } from '../wizard/wizard.state';
import { UpdateComparison } from '../wizard/wizard.actions';
import {
  ClearComparisonResult,
  ComparisonLeadSubmitted,
  ReviseComparisonTier,
  RunComparison,
} from './comparison.actions';

/** Loading lifecycle for the comparison results. */
export type ComparisonStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Pipeline stage during `loading` — drives the analyzing beat 1:1. */
export type ComparisonStage = 'validating' | 'fetching' | 'calculating';

export interface ComparisonStateModel {
  /**
   * The comparison response: real ranges for every row-set. The API returns
   * full figures; the UI blurs build/total until the lead gate converts
   * (see the visibility hints on each row-set). Persisted — the user's own
   * figures, so the results render after a refresh (still gated).
   */
  result: ComparisonEstimateResponse | null;
  /** Community stats keyed by slug — the real City-assessed values. */
  stats: Record<string, CommunityStats>;
  /** Unlock from the lead gate (successful lead submission). Memory-only. */
  leadId: string | null;
  status: ComparisonStatus;
  /** Current pipeline stage while loading; null when idle/ready/error. */
  stage: ComparisonStage | null;
  /** Load/re-run failure flag. The raw error never reaches the UI. */
  error: string | null;
}

const defaults: ComparisonStateModel = {
  result: null,
  stats: {},
  leadId: null,
  status: 'idle',
  stage: null,
  error: null,
};

/**
 * Comparison state (NBH-03): the single source of truth for the
 * /estimate/compare results.
 *
 * The pipeline runs in two real stages: fetch each community's stats
 * (real City-assessed values), then run the comparison estimate. Both are
 * awaited before `ready` — the analyzing beat's stages map 1:1 onto them.
 *
 * Action handlers RETURN their API observables (never bare `.subscribe()`):
 * NGXS then owns the subscription, so a newer `ReviseComparisonTier`
 * cancels an in-flight run and no stale response can overwrite a newer
 * result.
 */
@State<ComparisonStateModel>({
  name: 'comparison',
  defaults,
})
@Injectable()
export class ComparisonState {
  private readonly api = inject(API_SERVICE);
  private readonly store = inject(Store);

  @Selector()
  static result(state: ComparisonStateModel): ComparisonEstimateResponse | null {
    return state.result;
  }

  @Selector()
  static stats(state: ComparisonStateModel): Record<string, CommunityStats> {
    return state.stats;
  }

  @Selector()
  static status(state: ComparisonStateModel): ComparisonStatus {
    return state.status;
  }

  @Selector()
  static stage(state: ComparisonStateModel): ComparisonStage | null {
    return state.stage;
  }

  @Selector()
  static error(state: ComparisonStateModel): string | null {
    return state.error;
  }

  @Selector()
  static leadId(state: ComparisonStateModel): string | null {
    return state.leadId;
  }

  /** True once the lead gate has converted (successful lead submission). */
  @Selector()
  static unlocked(state: ComparisonStateModel): boolean {
    return state.leadId !== null;
  }

  @Action(RunComparison)
  runComparison(ctx: StateContext<ComparisonStateModel>): Observable<unknown> {
    const comparison = this.store.selectSnapshot(WizardState.comparison);
    if (comparison.slugs.length < 2 || comparison.slugs.length > 3) {
      ctx.patchState({ status: 'error', stage: null, error: 'comparison_invalid' });
      return of(null);
    }
    ctx.patchState({ status: 'loading', stage: 'validating', error: null });

    const stats$ = forkJoin(
      comparison.slugs.map((slug) =>
        this.api.getCommunityStats(slug).pipe(
          catchError(() => of(null)),
        ),
      ),
    ).pipe(
      // Fires on subscribe — exactly when the stats fetch starts.
      tap({ subscribe: () => ctx.patchState({ stage: 'fetching' }) }),
    );

    return stats$.pipe(
      switchMap((statsList) => {
        const stats: Record<string, CommunityStats> = {};
        for (let i = 0; i < comparison.slugs.length; i++) {
          const statsEntry = statsList[i];
          // A missing stats entry means we cannot show the card honestly —
          // fail the run rather than render without the assessed value.
          if (!statsEntry) {
            throw { code: 'stats_unavailable', retryable: true };
          }
          stats[comparison.slugs[i]] = statsEntry;
        }
        ctx.patchState({ stage: 'calculating' });
        return this.api
          .getComparisonEstimate({
            projectType: 'comparison',
            neighbourhoods: [...comparison.slugs],
            sqft: comparison.sqft,
            tier: comparison.tier,
          })
          .pipe(
            tap((result) =>
              ctx.patchState({ result, stats, status: 'ready', stage: null }),
            ),
          );
      }),
      catchError(() => {
        ctx.patchState({ status: 'error', stage: null, error: 'comparison_failed' });
        return of(null);
      }),
    );
  }

  @Action(ReviseComparisonTier)
  reviseComparisonTier(
    ctx: StateContext<ComparisonStateModel>,
    action: ReviseComparisonTier,
  ): Observable<unknown> {
    // The tier lives in the wizard's comparison inputs (persisted); re-run
    // the whole pipeline so every row-set is recalculated at the new tier.
    // Sequence via ctx.dispatch so the tier update lands before runComparison
    // reads it.
    return ctx
      .dispatch(new UpdateComparison({ tier: action.tier }))
      .pipe(switchMap(() => this.runComparison(ctx)));
  }

  @Action(ComparisonLeadSubmitted)
  comparisonLeadSubmitted(
    ctx: StateContext<ComparisonStateModel>,
    action: ComparisonLeadSubmitted,
  ): void {
    ctx.patchState({ leadId: action.leadId });
  }

  @Action(ClearComparisonResult)
  clearComparisonResult(ctx: StateContext<ComparisonStateModel>): void {
    ctx.setState({ ...defaults });
  }
}
