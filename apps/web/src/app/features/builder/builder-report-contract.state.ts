import { inject, Injectable } from '@angular/core';
import { of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import type { ApiError } from '@feasly/contracts';
import {
  BuilderBillingApiService,
  type ReportContractResult,
} from './builder-billing-api.service';
import {
  ClearReportContractState,
  ResetReportContract,
  SubmitReportContract,
} from './builder-report-contract.actions';

/** Submit lifecycle for the report-contract form. */
export type ReportContractSubmitStatus =
  | 'idle'
  | 'submitting'
  | 'success'
  | 'error';

export interface BuilderReportContractStateModel {
  /** Submit lifecycle. */
  submitStatus: ReportContractSubmitStatus;
  /** The backend's billing outcome (mirrors BillableEventResult). */
  result: ReportContractResult | null;
  /** The reported contract value in cents (for the success summary). */
  reportedValueCents: number | null;
  /** RFC 7807-surfaced ApiError on submit failure. */
  error: ApiError | null;
}

const defaults: BuilderReportContractStateModel = {
  submitStatus: 'idle',
  result: null,
  reportedValueCents: null,
  error: null,
};

/**
 * Builder report-contract state: the single source of truth for the
 * `/builder/report-contract` page.
 *
 * Memory-only — nothing about a contract report is persisted client-side.
 * The state dispatches the report through BuilderBillingApiService and
 * keeps the backend's outcome (draft invoice created, idempotent
 * duplicate, flat-plan covered, billing not enabled) for the confirmation
 * view. Attribution and the 7-day review window are server-side only.
 */
@State<BuilderReportContractStateModel>({
  name: 'builderReportContract',
  defaults,
})
@Injectable()
export class BuilderReportContractState {
  private readonly api = inject(BuilderBillingApiService);

  @Selector()
  static submitStatus(
    state: BuilderReportContractStateModel,
  ): ReportContractSubmitStatus {
    return state.submitStatus;
  }

  @Selector()
  static result(
    state: BuilderReportContractStateModel,
  ): ReportContractResult | null {
    return state.result;
  }

  @Selector()
  static reportedValueCents(
    state: BuilderReportContractStateModel,
  ): number | null {
    return state.reportedValueCents;
  }

  @Selector()
  static error(state: BuilderReportContractStateModel): ApiError | null {
    return state.error;
  }

  @Action(SubmitReportContract)
  submit(
    ctx: StateContext<BuilderReportContractStateModel>,
    action: SubmitReportContract,
  ) {
    ctx.patchState({ submitStatus: 'submitting', error: null, result: null });
    return this.api
      .reportContract({
        leadId: action.leadId,
        contractValueCents: action.contractValueCents,
        contractSignedAt: action.contractSignedAt,
      })
      .pipe(
        tap((result) =>
          ctx.patchState({
            submitStatus: 'success',
            result,
            reportedValueCents: action.contractValueCents,
          }),
        ),
        catchError((error: unknown) => {
          ctx.patchState({
            submitStatus: 'error',
            error: error as ApiError,
          });
          return of(null);
        }),
      );
  }

  @Action(ResetReportContract)
  reset(ctx: StateContext<BuilderReportContractStateModel>) {
    ctx.setState(defaults);
  }

  @Action(ClearReportContractState)
  clear(ctx: StateContext<BuilderReportContractStateModel>) {
    ctx.setState(defaults);
  }
}
