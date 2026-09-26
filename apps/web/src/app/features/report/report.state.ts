import { inject, Injectable } from '@angular/core';
import { EMPTY, catchError, tap } from 'rxjs';
import { Action, Selector, State, StateContext, Store } from '@ngxs/store';
import type { PreviewEstimateResponse, ReportSnapshot } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { WizardState } from '../wizard/wizard.state';
import { ClearReport, LoadPreview, ReviseReport, SetReportToken, UnlockReport } from './report.actions';

/** Loading lifecycle for the report page. */
export type ReportStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ReportStateModel {
  /** Pre-gate preview with the real computed figures (the UI renders them
   * blurred until the lead gate unlocks). Carries no PII. */
  preview: PreviewEstimateResponse | null;
  /** Bearer token from magic-link verification. Memory-only — stripped before storage persistence. */
  reportToken: string | null;
  /** Post-gate verified snapshot. Null until unlocked. */
  snapshot: ReportSnapshot | null;
  status: ReportStatus;
  /** Load/re-run failure flag. The raw error never reaches the UI. */
  error: string | null;
}

const defaults: ReportStateModel = {
  preview: null,
  reportToken: null,
  snapshot: null,
  status: 'idle',
  error: null,
};

/**
 * Report state: the single source of truth for the estimate report page.
 *
 * Pre-gate the model holds the real-figures preview (rendered blurred);
 * post-gate it holds the
 * verified snapshot. The component never calls the API directly — it
 * dispatches actions and renders selectors. The wizard slice supplies the
 * property + inputs the estimate is based on.
 *
 * Action handlers RETURN their API observables (never bare `.subscribe()`):
 * NGXS then owns the subscription, so a newer `ReviseReport` cancels an
 * in-flight one and no stale response can overwrite a newer snapshot.
 */
@State<ReportStateModel>({
  name: 'report',
  defaults,
})
@Injectable()
export class ReportState {
  private readonly api = inject(API_SERVICE);
  private readonly store = inject(Store);

  @Selector()
  static preview(state: ReportStateModel): PreviewEstimateResponse | null {
    return state.preview;
  }

  @Selector()
  static snapshot(state: ReportStateModel): ReportSnapshot | null {
    return state.snapshot;
  }

  @Selector()
  static reportToken(state: ReportStateModel): string | null {
    return state.reportToken;
  }

  @Selector()
  static status(state: ReportStateModel): ReportStatus {
    return state.status;
  }

  @Selector()
  static error(state: ReportStateModel): string | null {
    return state.error;
  }

  /** True once a verified snapshot exists — the post-gate view. */
  @Selector()
  static unlocked(state: ReportStateModel): boolean {
    return state.snapshot !== null;
  }

  private beginLoad(ctx: StateContext<ReportStateModel>): void {
    ctx.patchState({ status: 'loading', error: null });
  }

  private fail(ctx: StateContext<ReportStateModel>): void {
    ctx.patchState({ status: 'error', error: 'load' });
  }

  @Action(LoadPreview)
  loadPreview(ctx: StateContext<ReportStateModel>) {
    const property = this.store.selectSnapshot(WizardState.property);
    const projectType = this.store.selectSnapshot(WizardState.projectType);
    
    if (!property) {
      this.fail(ctx);
      return;
    }
    
    // RENO-04: build the preview request from reno inputs when projectType is renovation
    let request: Parameters<typeof this.api.getPreviewEstimate>[0];
    if (projectType === 'renovation') {
      const reno = this.store.selectSnapshot(WizardState.renoInputs);
      if (!reno.renoType || !reno.tier || reno.renoSqft <= 0) {
        this.fail(ctx);
        return;
      }
      request = {
        projectType: 'renovation',
        addressKey: property.addressKey,
        renoType: reno.renoType,
        renoSqft: reno.renoSqft,
        tier: reno.tier,
        underpinning: reno.underpinning,
      };
    } else {
      const inputs = this.store.selectSnapshot(WizardState.inputs);
      if (inputs.sqft <= 0) {
        this.fail(ctx);
        return;
      }
      request = { addressKey: property.addressKey, ...inputs };
    }
    
    this.beginLoad(ctx);
    return this.api.getPreviewEstimate(request).pipe(
      tap((preview) => ctx.patchState({ preview, status: 'ready' })),
      catchError(() => {
        this.fail(ctx);
        return EMPTY;
      }),
    );
  }

  @Action(SetReportToken)
  setReportToken(ctx: StateContext<ReportStateModel>, action: SetReportToken): void {
    ctx.patchState({ reportToken: action.reportToken, snapshot: null });
  }

  @Action(UnlockReport)
  unlockReport(ctx: StateContext<ReportStateModel>) {
    const token = ctx.getState().reportToken;
    if (!token) {
      this.fail(ctx);
      return;
    }
    this.beginLoad(ctx);
    return this.api.getReport(token).pipe(
      tap((snapshot) => ctx.patchState({ snapshot, status: 'ready' })),
      catchError(() => {
        this.fail(ctx);
        return EMPTY;
      }),
    );
  }

  /**
   * Inline sqft/tier revision. `cancelUncompleted` gives switchMap semantics:
   * dispatching a newer revision tears down the previous in-flight request,
   * so a slow (stale) response can never overwrite a newer snapshot. The
   * component debounces rapid stepper taps before dispatching (D-02).
   */
  @Action(ReviseReport, { cancelUncompleted: true })
  reviseReport(ctx: StateContext<ReportStateModel>, action: ReviseReport) {
    const token = ctx.getState().reportToken;
    if (!token) {
      // No token (e.g. after a reload — the token is memory-only by design).
      // Fail honestly with the inline error instead of silently doing nothing:
      // the magic-link email is the only re-verification path.
      this.fail(ctx);
      return;
    }
    this.beginLoad(ctx);
    return this.api.reviseTier(token, { tier: action.tier, sqft: action.sqft }).pipe(
      tap((snapshot) => ctx.patchState({ snapshot, status: 'ready' })),
      catchError(() => {
        this.fail(ctx);
        return EMPTY;
      }),
    );
  }

  @Action(ClearReport)
  clearReport(ctx: StateContext<ReportStateModel>): void {
    ctx.setState({ ...defaults });
  }
}
