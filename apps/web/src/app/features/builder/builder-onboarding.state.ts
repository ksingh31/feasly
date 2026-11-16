import { inject, Injectable, makeEnvironmentProviders } from '@angular/core';
import type { EnvironmentProviders } from '@angular/core';
import { of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import type {
  AgreementErrorCode,
  AgreementStatus,
  ApiError,
  BuilderOnboardingStatus,
} from '@feasly/contracts';
import { BuilderOnboardingApiService } from './builder-onboarding-api.service';
import {
  AcceptBuilderAgreement,
  DismissOnboardingStep,
  LoadBuilderAgreement,
  LoadBuilderOnboarding,
  MarkBuilderAgreementRequired,
  type OnboardingStepId,
} from './builder-onboarding.actions';

export type BuilderOnboardingLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Why the last accept failed — the screen maps each to its own copy. */
export type AgreementAcceptError = 'versionChanged' | 'adminRequired' | 'failed';

export interface BuilderOnboardingStateModel {
  agreement: AgreementStatus | null;
  agreementStatus: BuilderOnboardingLoadStatus;
  onboarding: BuilderOnboardingStatus | null;
  onboardingStatus: BuilderOnboardingLoadStatus;
  /** Accept request in flight (blocks double submits). */
  accepting: boolean;
  acceptError: AgreementAcceptError | null;
}

const defaults: BuilderOnboardingStateModel = {
  agreement: null,
  agreementStatus: 'idle',
  onboarding: null,
  onboardingStatus: 'idle',
  accepting: false,
  acceptError: null,
};

function acceptErrorKind(err: Partial<ApiError> | null | undefined): AgreementAcceptError {
  // Type-only contract import (string codes checked against
  // AgreementErrorCode): a runtime import of the CommonJS contracts
  // package would bail out of build optimization.
  switch (err?.code as AgreementErrorCode | undefined) {
    case 'AGREEMENT_VERSION_MISMATCH':
      return 'versionChanged';
    case 'AGREEMENT_ADMIN_REQUIRED':
      return 'adminRequired';
    default:
      return 'failed';
  }
}

/**
 * Builder onboarding state (#722): the platform-agreement status (with the
 * served text) and the first-run checklist flags. Memory-only — both are
 * re-fetched per visit and never persisted (the server is the authority;
 * every flag is computed there).
 *
 * Action handlers RETURN their API observables (never bare `.subscribe()`):
 * NGXS owns the subscription.
 */
@State<BuilderOnboardingStateModel>({
  name: 'builderOnboarding',
  defaults,
})
@Injectable()
export class BuilderOnboardingState {
  private readonly api = inject(BuilderOnboardingApiService);

  // Selectors tolerate an unregistered slice (state undefined) so pages
  // that render outside the shell (specs, lazy edges) never throw.
  @Selector()
  static agreement(state: BuilderOnboardingStateModel): AgreementStatus | null {
    return state?.agreement ?? null;
  }

  @Selector()
  static agreementStatus(state: BuilderOnboardingStateModel): BuilderOnboardingLoadStatus {
    return state?.agreementStatus ?? 'idle';
  }

  /** True/false once known; null before the status loads. */
  @Selector()
  static agreementCurrent(state: BuilderOnboardingStateModel): boolean | null {
    return state?.agreement ? state.agreement.current : null;
  }

  @Selector()
  static onboarding(state: BuilderOnboardingStateModel): BuilderOnboardingStatus | null {
    return state?.onboarding ?? null;
  }

  @Selector()
  static onboardingStatus(state: BuilderOnboardingStateModel): BuilderOnboardingLoadStatus {
    return state?.onboardingStatus ?? 'idle';
  }

  @Selector()
  static accepting(state: BuilderOnboardingStateModel): boolean {
    return state?.accepting ?? false;
  }

  @Selector()
  static acceptError(state: BuilderOnboardingStateModel): AgreementAcceptError | null {
    return state?.acceptError ?? null;
  }

  @Action(LoadBuilderAgreement)
  loadAgreement(ctx: StateContext<BuilderOnboardingStateModel>): Observable<unknown> {
    ctx.patchState({ agreementStatus: 'loading' });
    return this.api.getAgreement().pipe(
      tap((agreement) => ctx.patchState({ agreement, agreementStatus: 'ready' })),
      catchError(() => {
        ctx.patchState({ agreementStatus: 'error' });
        return of(null);
      }),
    );
  }

  @Action(LoadBuilderOnboarding)
  loadOnboarding(ctx: StateContext<BuilderOnboardingStateModel>): Observable<unknown> {
    ctx.patchState({ onboardingStatus: 'loading' });
    return this.api.getOnboarding().pipe(
      tap((onboarding) =>
        ctx.patchState({
          onboarding,
          onboardingStatus: 'ready',
          // The checklist carries the same status — keep the agreement fresh.
          agreement: onboarding.agreement,
          agreementStatus: 'ready',
        }),
      ),
      catchError(() => {
        ctx.patchState({ onboardingStatus: 'error' });
        return of(null);
      }),
    );
  }

  @Action(AcceptBuilderAgreement)
  accept(
    ctx: StateContext<BuilderOnboardingStateModel>,
    action: AcceptBuilderAgreement,
  ): Observable<unknown> {
    if (ctx.getState().accepting) return of(null);
    ctx.patchState({ accepting: true, acceptError: null });
    return this.api.acceptAgreement(action.version).pipe(
      tap((agreement) =>
        ctx.patchState({ agreement, agreementStatus: 'ready', accepting: false }),
      ),
      // Refresh the checklist so the agreement step flips to done.
      switchMap(() => ctx.dispatch(new LoadBuilderOnboarding())),
      catchError((err: Partial<ApiError> | null) => {
        const kind = acceptErrorKind(err);
        ctx.patchState({ accepting: false, acceptError: kind });
        // A newer version is out: load its text so the reader can review it.
        return kind === 'versionChanged' ? ctx.dispatch(new LoadBuilderAgreement()) : of(null);
      }),
    );
  }

  @Action(MarkBuilderAgreementRequired)
  markRequired(ctx: StateContext<BuilderOnboardingStateModel>): void {
    const { agreement, onboarding } = ctx.getState();
    ctx.patchState({
      agreement: agreement ? { ...agreement, current: false, acceptedAt: null, acceptedBy: null } : null,
      onboarding: onboarding
        ? { ...onboarding, agreementAccepted: false, complete: false }
        : null,
    });
  }
}

export interface BuilderChecklistStateModel {
  /**
   * Completed steps the builder hid, per org id. Persisted by the storage
   * plugin (key `builderChecklist`): step ids + opaque org ids, no PII. A
   * dismissed step reappears if it becomes incomplete again (a new
   * agreement version), because only done steps honour dismissal.
   */
  dismissed: Readonly<Record<string, readonly OnboardingStepId[]>>;
}

/**
 * Checklist dismissal UI state (#722). Split from BuilderOnboardingState
 * so only this slice persists; server flags never touch localStorage.
 */
@State<BuilderChecklistStateModel>({
  name: 'builderChecklist',
  defaults: { dismissed: {} },
})
@Injectable()
export class BuilderChecklistState {
  @Selector()
  static dismissed(
    state: BuilderChecklistStateModel,
  ): Readonly<Record<string, readonly OnboardingStepId[]>> {
    return state?.dismissed ?? {};
  }

  @Action(DismissOnboardingStep)
  dismiss(ctx: StateContext<BuilderChecklistStateModel>, action: DismissOnboardingStep): void {
    const dismissed = ctx.getState().dismissed ?? {};
    const current = dismissed[action.builderId] ?? [];
    if (current.includes(action.step)) return;
    ctx.patchState({
      dismissed: { ...dismissed, [action.builderId]: [...current, action.step] },
    });
  }
}

/**
 * Lazy provider for the builder shell route (via lazyProvider in
 * app.routes.ts): keeps both states out of the initial bundle. The storage
 * plugin rehydrates `builderChecklist` on the lazy UpdateState.
 */
export const builderOnboardingStateProvider: EnvironmentProviders =
  makeEnvironmentProviders([provideStates([BuilderOnboardingState, BuilderChecklistState])]);
