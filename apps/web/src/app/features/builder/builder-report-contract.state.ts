import { inject, Injectable } from '@angular/core';
import { of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import type { ApiError, CommissionInvoice } from '@feasly/contracts';
import {
  BuilderBillingApiService,
  type ReportContractResult,
} from './builder-billing-api.service';
import { BuilderInvoicesApiService } from './builder-invoices-api.service';
import {
  ClearReportContractState,
  ResetReportContract,
  SubmitReportContract,
} from './builder-report-contract.actions';

/** Submit lifecycle for the record-contract form. */
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
  /** The minted invoice, fetched for the success card (dates + status). */
  invoice: CommissionInvoice | null;
  /** RFC 7807-surfaced ApiError on submit failure. */
  error: ApiError | null;
}

const defaults: BuilderReportContractStateModel = {
  submitStatus: 'idle',
  result: null,
  reportedValueCents: null,
  invoice: null,
  error: null,
};

/**
 * Builder record-contract state: the single source of truth for the
 * `/builder/record-contract` page.
 *
 * Memory-only — nothing about a contract record is persisted client-side.
 * The state dispatches the record through BuilderBillingApiService, then
 * fetches the minted invoice so the confirmation card shows the real
 * review deadline and auto-charge date. Attribution and the 7-day review
 * window are server-side only.
 */
@State<BuilderReportContractStateModel>({
  name: 'builderReportContract',
  defaults,
})
@Injectable()
export class BuilderReportContractState {
  private readonly api = inject(BuilderBillingApiService);
  private readonly invoicesApi = inject(BuilderInvoicesApiService);

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
  static invoice(state: BuilderReportContractStateModel): CommissionInvoice | null {
    return state.invoice;
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
    ctx.patchState({
      submitStatus: 'submitting',
      error: null,
      result: null,
      invoice: null,
    });
    return this.api
      .reportContract({
        leadId: action.leadId,
        contractValueCents: action.contractValueCents,
        contractSignedAt: action.contractSignedAt,
      })
      .pipe(
        switchMap((result) => {
          ctx.patchState({
            result,
            reportedValueCents: action.contractValueCents,
          });
          // Fetch the minted invoice so the confirmation card shows the
          // real review deadline and auto-charge date. The idempotent
          // duplicate outcome returns the existing invoice id too.
          if (result.billed && result.invoiceId) {
            return this.invoicesApi.getInvoice(result.invoiceId).pipe(
              tap((invoice) =>
                ctx.patchState({ submitStatus: 'success', invoice }),
              ),
              catchError(() =>
                // The record succeeded; the card just can't show the
                // invoice dates. Still a success.
                of(ctx.patchState({ submitStatus: 'success' })),
              ),
            );
          }
          return of(ctx.patchState({ submitStatus: 'success' }));
        }),
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
