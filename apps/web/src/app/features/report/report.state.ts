import { inject, Injectable } from '@angular/core';
import { Action, Selector, State, StateContext, Store } from '@ngxs/store';
import type { PreviewEstimateResponse, ReportSnapshot } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { WizardState } from '../wizard/wizard.state';
import { ClearReport, LoadPreview, ReviseReport, SetReportToken, UnlockReport } from './report.actions';

/** Loading lifecycle for the report page. */
export type ReportStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ReportStateModel {
  /** Pre-gate blurred preview. Never carries real figures (by contract type). */
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
 * Report state (M1): the single source of truth for the estimate report page.
 *
 * Pre-gate the model holds the blurred preview; post-gate it holds the
 * verified snapshot. The component never calls the API directly — it
 * dispatches actions and renders selectors. The wizard slice supplies the
 * property + inputs the estimate is based on.
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
  loadPreview(ctx: StateContext<ReportStateModel>): void {
    this.beginLoad(ctx);
    const property = this.store.selectSnapshot(WizardState.property);
    const inputs = this.store.selectSnapshot(WizardState.inputs);
    if (!property || inputs.sqft <= 0) {
      this.fail(ctx);
      return;
    }
    this.api.getPreviewEstimate({ addressKey: property.addressKey, ...inputs }).subscribe({
      next: (preview) => ctx.patchState({ preview, status: 'ready' }),
      error: () => this.fail(ctx),
    });
  }

  @Action(SetReportToken)
  setReportToken(ctx: StateContext<ReportStateModel>, action: SetReportToken): void {
    ctx.patchState({ reportToken: action.reportToken, snapshot: null });
  }

  @Action(UnlockReport)
  unlockReport(ctx: StateContext<ReportStateModel>): void {
    const token = ctx.getState().reportToken;
    if (!token) {
      this.fail(ctx);
      return;
    }
    this.beginLoad(ctx);
    this.api.getReport(token).subscribe({
      next: (snapshot) => ctx.patchState({ snapshot, status: 'ready' }),
      error: () => this.fail(ctx),
    });
  }

  @Action(ReviseReport)
  reviseReport(ctx: StateContext<ReportStateModel>, action: ReviseReport): void {
    const token = ctx.getState().reportToken;
    if (!token) {
      // No token (e.g. after a reload — the token is memory-only by design).
      // Fail honestly with the inline error instead of silently doing nothing:
      // the magic-link email is the only re-verification path.
      this.fail(ctx);
      return;
    }
    this.beginLoad(ctx);
    this.api.reviseTier(token, { tier: action.tier, sqft: action.sqft }).subscribe({
      next: (snapshot) => ctx.patchState({ snapshot, status: 'ready' }),
      error: () => this.fail(ctx),
    });
  }

  @Action(ClearReport)
  clearReport(ctx: StateContext<ReportStateModel>): void {
    ctx.setState({ ...defaults });
  }
}
