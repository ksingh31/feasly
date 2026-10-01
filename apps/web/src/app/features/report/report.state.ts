import { inject, Injectable } from '@angular/core';
import { EMPTY, catchError, map, of, switchMap, tap } from 'rxjs';
import type { Observable } from 'rxjs';
import { Action, Selector, State, StateContext, Store } from '@ngxs/store';
import type {
  ApiError,
  EstimateResponse,
  FinishTier,
  PreviewEstimateResponse,
  ReportSnapshot,
} from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { buildNewBuildRequest } from '../../core/api/build-estimate-request';
import { LeadState } from '../wizard/lead.state';
import { WizardState } from '../wizard/wizard.state';
import { ClearReport, LoadLeadEstimate, LoadPreview, ReviseReport, SetPartnerView, SetReportToken, ToggleStep, UnlockReport } from './report.actions';

/** Loading lifecycle for the report page. */
export type ReportStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ReportStateModel {
  /** Pre-gate preview with the real computed figures (the UI renders them
   * blurred until the lead gate unlocks). Carries no PII. */
  preview: PreviewEstimateResponse | null;
  /** Bearer token from magic-link verification. Memory-only — stripped before storage persistence. */
  reportToken: string | null;
  /**
   * True when the session came from a partner-share link: the report page
   * renders its read-only partner view (no share/callback/stepper).
   */
  partnerView: boolean;
  /** Post-gate verified snapshot. Null until unlocked. */
  snapshot: ReportSnapshot | null;
  /**
   * Highest report revision number reached this browser, persisted across
   * reloads (the snapshot itself is session-scoped and stripped before
   * persistence). After a reload the report is rebuilt from the persisted
   * wizard inputs — the version label keeps counting from here instead of
   * restarting at 1, so "Report version 3" still reads "version 3" with the
   * v3 figures. Reset by ClearReport (a new property starts a new count).
   */
  savedVersion: number;
  status: ReportStatus;
  /** Load/re-run failure flag. The raw error never reaches the UI. */
  error: string | null;
  /**
   * API error detail for diagnostics-friendly UI (e.g. the validation
   * message when a 400 explains itself). The UI translates it to
   * buyer-grade copy — never rendered verbatim.
   */
  errorDetail: string | null;
  /**
   * Next-steps checklist: which step ids are checked. Persisted (not
   * stripped by beforeSerialize) and keyed by `stepsLeadId` — the leadId is
   * stable across reloads and magic-link devices, unlike the per-request
   * estimateId. Reset when a different report loads; cleared by
   * ClearReport (a new property starts fresh).
   */
  stepsChecked: Record<string, boolean>;
  /** leadId the stepsChecked map belongs to; null before the first report. */
  stepsLeadId: string | null;
}

const defaults: ReportStateModel = {
  preview: null,
  reportToken: null,
  partnerView: false,
  snapshot: null,
  savedVersion: 0,
  status: 'idle',
  error: null,
  errorDetail: null,
  stepsChecked: {},
  stepsLeadId: null,
};

/**
 * Report state: the single source of truth for the estimate report page.
 *
 * Pre-gate the model holds the real-figures preview (rendered blurred);
 * post-gate it holds the report snapshot. The snapshot arrives either via
 * the magic-link report token (`UnlockReport`) or — Karan directive
 * 2026-09-27 — immediately after the lead gate is submitted
 * (`LoadLeadEstimate`, sourced from the public estimate endpoint; the blur
 * was a nudge, not a boundary). The component never calls the API directly
 * — it dispatches actions and renders selectors. The wizard slice supplies
 * the property + inputs the estimate is based on.
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

  /** True when the session redeemed a partner-share link (read-only view). */
  @Selector()
  static partnerView(state: ReportStateModel): boolean {
    return state.partnerView;
  }

  @Selector()
  static status(state: ReportStateModel): ReportStatus {
    return state.status;
  }

  @Selector()
  static error(state: ReportStateModel): string | null {
    return state.error;
  }

  @Selector()
  static errorDetail(state: ReportStateModel): string | null {
    return state.errorDetail;
  }

  /** True once a verified snapshot exists — the post-gate view. */
  @Selector()
  static unlocked(state: ReportStateModel): boolean {
    return state.snapshot !== null;
  }

  /** Checked ids of the next-steps checklist (keyed by stepsLeadId). */
  @Selector()
  static stepsChecked(state: ReportStateModel): Record<string, boolean> {
    return state.stepsChecked;
  }

  /** leadId the persisted checklist belongs to. */
  @Selector()
  static stepsLeadId(state: ReportStateModel): string | null {
    return state.stepsLeadId;
  }

  private beginLoad(ctx: StateContext<ReportStateModel>): void {
    ctx.patchState({ status: 'loading', error: null, errorDetail: null });
  }

  /**
   * Marks the load as failed. When the API error is available and flagged
   * non-retryable (e.g. a 400 validation failure), the failure is classified
   * as 'validation' so the UI can explain the actual problem instead of
   * offering a retry that cannot succeed. The raw message is kept as
   * errorDetail for buyer-grade translation — never rendered verbatim.
   */
  private fail(ctx: StateContext<ReportStateModel>, err?: unknown): void {
    const apiError = err as Partial<ApiError> | undefined;
    const message = typeof apiError?.message === 'string' ? apiError.message : null;
    const validation = apiError?.retryable === false;
    ctx.patchState({
      status: 'error',
      error: validation ? 'validation' : 'load',
      errorDetail: message,
    });
  }

  /**
   * Single place that lands a new snapshot: the revision counter travels
   * with it, so a reload (which strips the snapshot but keeps
   * `savedVersion`) rebuilds the same version instead of restarting at 1.
   * The next-steps checklist resets when a DIFFERENT report loads (a new
   * leadId) but survives reloads and sqft revises of the same report —
   * the leadId is stable across both, unlike the per-request estimateId.
   */
  private setSnapshot(ctx: StateContext<ReportStateModel>, snapshot: ReportSnapshot): void {
    const state = ctx.getState();
    const sameReport = state.stepsLeadId !== null && state.stepsLeadId === snapshot.leadId;
    ctx.patchState({
      snapshot,
      savedVersion: snapshot.version,
      status: 'ready',
      stepsLeadId: snapshot.leadId,
      stepsChecked: sameReport ? state.stepsChecked : {},
    });
  }

  /**
   * Next revision number for a locally-built (lead-path) snapshot. The max
   * of the in-memory snapshot and the persisted counter wins, so a revise
   * after a reload continues the count instead of restarting it.
   */
  private nextLocalVersion(ctx: StateContext<ReportStateModel>): number {
    const state = ctx.getState();
    return Math.max(state.snapshot?.version ?? 0, state.savedVersion) + 1;
  }

  /**
   * Builds the estimate request from the wizard state (RENO-04: reno inputs
   * when projectType is renovation). Shared by `LoadPreview` (preview
   * endpoint) and `LoadLeadEstimate` / the no-token `ReviseReport` fallback
   * (public full-estimate endpoint — same request shape, richer response).
   * Optional overrides apply a stepper/tier revision without mutating the
   * wizard state first (the component dispatches `UpdateInputs` alongside).
   * Returns null when the wizard basis is incomplete — callers fail honestly.
   */
  private buildEstimateRequest(overrides?: {
    sqft?: number;
    tier?: FinishTier;
  }): Parameters<typeof this.api.getEstimate>[0] | null {
    const property = this.store.selectSnapshot(WizardState.property);
    const projectType = this.store.selectSnapshot(WizardState.projectType);

    if (!property) {
      return null;
    }

    // RENO-04: build the request from reno inputs when projectType is renovation
    if (projectType === 'renovation') {
      const reno = this.store.selectSnapshot(WizardState.renoInputs);
      const renoSqft = overrides?.sqft ?? reno.renoSqft;
      const tier = overrides?.tier ?? reno.tier;
      if (!reno.renoType || !tier || renoSqft <= 0) {
        return null;
      }
      return {
        projectType: 'renovation',
        addressKey: property.addressKey,
        renoType: reno.renoType,
        renoSqft,
        tier,
        underpinning: reno.underpinning,
      };
    }

    const inputs = this.store.selectSnapshot(WizardState.inputs);
    const sqft = overrides?.sqft ?? inputs.sqft;
    if (sqft <= 0) {
      return null;
    }
    return buildNewBuildRequest(property, {
      ...inputs,
      sqft,
      tier: overrides?.tier ?? inputs.tier,
    });
  }

  @Action(LoadPreview)
  loadPreview(ctx: StateContext<ReportStateModel>) {
    const request = this.buildEstimateRequest();
    if (!request) {
      this.fail(ctx);
      return EMPTY;
    }

    this.beginLoad(ctx);
    return this.api.getPreviewEstimate(request).pipe(
      tap((preview) => ctx.patchState({ preview, status: 'ready' })),
      catchError((err: unknown) => {
        this.fail(ctx, err);
        return EMPTY;
      }),
    );
  }

  /**
   * Maps a public full-estimate response onto the report snapshot the page
   * renders. The figures and cost rows are the same deterministic engine
   * output the token path would return; the token-only extras stay empty —
   * the AI narrative, token revise, share, and callback still need the
   * magic-link email (now return-access for other devices, not the unlock
   * key for this session). `leadId` ties the snapshot to the submitted lead.
   */
  private toLeadSnapshot(
    estimate: EstimateResponse,
    leadId: string,
    version: number,
  ): ReportSnapshot {
    return {
      snapshotId: `lead-${estimate.estimateId}`,
      estimateId: estimate.estimateId,
      leadId,
      inputs: estimate.inputs,
      buildRange: estimate.figures.build,
      totalRange: estimate.figures.total,
      landValue: estimate.figures.land,
      rows: estimate.rows,
      // No token in this path, so no narrative fetch is possible — the page
      // shows the honest empty state, never mock text.
      narrative: '',
      preparedAt: estimate.createdAt,
      version,
      projectType: estimate.projectType,
      renoInputs: estimate.renoInputs,
      assumptions: estimate.assumptions,
    };
  }

  /**
   * Immediate post-gate unlock (Karan directive 2026-09-27): the lead was
   * submitted in-session but there is no report token (the magic-link email
   * is on its way or was dedupe-suppressed). Runs the PUBLIC estimate
   * endpoint — auth:none by design, so this exposes nothing new — and
   * renders the full report at once: no blurred figures, no dead-end.
   */
  @Action(LoadLeadEstimate)
  loadLeadEstimate(ctx: StateContext<ReportStateModel>) {
    const leadId = this.store.selectSnapshot(LeadState.leadId);
    const request = this.buildEstimateRequest();
    if (!leadId || !request) {
      this.fail(ctx);
      return EMPTY;
    }

    this.beginLoad(ctx);
    return this.api.getEstimate(request).pipe(
      tap((estimate) => {
        // This action never starts a new revision — it (re)builds the
        // CURRENT one: fresh unlocks start at 1, reloads keep the persisted
        // counter (the snapshot is session-scoped, the wizard inputs are
        // not), and retries of a failed load keep the last good version.
        const state = ctx.getState();
        const version =
          state.snapshot?.version ?? (state.savedVersion > 0 ? state.savedVersion : 1);
        this.setSnapshot(ctx, this.toLeadSnapshot(estimate, leadId, version));
      }),
      catchError((err: unknown) => {
        this.fail(ctx, err);
        return EMPTY;
      }),
    );
  }

  @Action(SetReportToken)
  setReportToken(ctx: StateContext<ReportStateModel>, action: SetReportToken): void {
    // A fresh token resets partner mode: owner links land here from the
    // owner verify path; the /r/:token page dispatches SetPartnerView right
    // after for partner links.
    ctx.patchState({ reportToken: action.reportToken, snapshot: null, partnerView: false });
  }

  @Action(SetPartnerView)
  setPartnerView(ctx: StateContext<ReportStateModel>): void {
    ctx.patchState({ partnerView: true });
  }

  /**
   * Narrative top-up (FE0-006): the real backend ships the AI narrative
   * separately from the snapshot (POST /v1/estimates/{id}/narrative), so a
   * snapshot that arrived with an empty narrative gets it fetched and folded
   * in. A narrative fetch failure keeps the snapshot as-is — the page then
   * shows the honest empty state, never mock text.
   */
  private withNarrative(
    token: string,
    snapshot: ReportSnapshot,
  ): Observable<ReportSnapshot> {
    if (snapshot.narrative?.trim()) {
      return of(snapshot);
    }
    return this.api.getNarrative(snapshot.estimateId, token).pipe(
      map((res) =>
        res.narrative?.trim()
          ? {
              ...snapshot,
              narrative: res.narrative,
              narrativeSource: res.narrativeSource,
            }
          : snapshot,
      ),
      catchError(() => of(snapshot)),
    );
  }

  @Action(UnlockReport)
  unlockReport(ctx: StateContext<ReportStateModel>) {
    const token = ctx.getState().reportToken;
    if (!token) {
      this.fail(ctx);
      return EMPTY;
    }
    this.beginLoad(ctx);
    return this.api.getReport(token).pipe(
      switchMap((snapshot) => this.withNarrative(token, snapshot)),
      // The backend owns the version here (append-only snapshot versions).
      tap((snapshot) => this.setSnapshot(ctx, snapshot)),
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
   *
   * Two paths: with a report token the revision runs against the token
   * endpoint; without one but with a submitted lead (Karan directive
   * 2026-09-27 — immediate post-gate unlock) it re-runs the PUBLIC estimate
   * endpoint with the revised size — the server still computes every figure,
   * so the component's money rule holds. With neither, it fails honestly:
   * the magic-link email is the only re-verification path.
   */
  @Action(ReviseReport, { cancelUncompleted: true })
  reviseReport(ctx: StateContext<ReportStateModel>, action: ReviseReport) {
    const token = ctx.getState().reportToken;
    if (token) {
      this.beginLoad(ctx);
      return this.api.reviseTier(token, { tier: action.tier, sqft: action.sqft }).pipe(
        switchMap((snapshot) => this.withNarrative(token, snapshot)),
        // The backend owns the version here (append-only snapshot versions).
        tap((snapshot) => this.setSnapshot(ctx, snapshot)),
        catchError(() => {
          this.fail(ctx);
          return EMPTY;
        }),
      );
    }
    // No token (e.g. same-session lead unlock — the token is memory-only and
    // the magic link may not have been clicked): re-run the public estimate
    // when a lead was submitted, so the stepper stays live.
    const leadId = this.store.selectSnapshot(LeadState.leadId);
    const request = this.buildEstimateRequest({ sqft: action.sqft, tier: action.tier });
    if (!leadId || !request) {
      // No lead either (e.g. after a reload — the token is memory-only by
      // design). Fail honestly with the inline error instead of silently
      // doing nothing: the magic-link email is the only re-verification path.
      this.fail(ctx);
      return EMPTY;
    }
    this.beginLoad(ctx);
    return this.api.getEstimate(request).pipe(
      tap((estimate) =>
        // A stepper/tier change IS a new revision — keep counting from the
        // persisted counter so a revise after a reload continues the
        // sequence instead of restarting at 1.
        this.setSnapshot(
          ctx,
          this.toLeadSnapshot(estimate, leadId, this.nextLocalVersion(ctx)),
        ),
      ),
      catchError((err: unknown) => {
        this.fail(ctx, err);
        return EMPTY;
      }),
    );
  }

  @Action(ClearReport)
  clearReport(ctx: StateContext<ReportStateModel>): void {
    ctx.setState({ ...defaults });
  }

  /**
   * Next-steps checklist toggle. Keyed by the current snapshot's leadId so
   * a toggle before the first snapshot lands (or after ClearReport) starts
   * a fresh map instead of inheriting another report's checks.
   */
  @Action(ToggleStep)
  toggleStep(ctx: StateContext<ReportStateModel>, action: ToggleStep): void {
    const state = ctx.getState();
    const leadId = state.snapshot?.leadId ?? null;
    const checked =
      leadId !== null && leadId === state.stepsLeadId ? { ...state.stepsChecked } : {};
    checked[action.stepId] = !checked[action.stepId];
    ctx.patchState({ stepsLeadId: leadId, stepsChecked: checked });
  }
}
