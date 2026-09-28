import {
  Component,
  DestroyRef,
  OnInit,
  inject,
} from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { Store } from '@ngxs/store';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { formatCentsToCad, onePercentOfCents, parseCadDollarsToCents } from '../../shared/utils/money';
import {
  dateOnlyToIsoWithOffset,
  todayLocalDateString,
} from '../../shared/utils/datetime';
import { BuilderState } from './builder.state';
import { LoadBuilderLeads } from './builder.actions';
import {
  ClearReportContractState,
  ResetReportContract,
  SubmitReportContract,
} from './builder-report-contract.actions';
import { BuilderReportContractState } from './builder-report-contract.state';
import type { ReportContractResult } from './builder-billing-api.service';

/** Typed report-contract form. The contract value is entered in CAD dollars. */
interface ReportContractForm {
  leadId: FormControl<string | null>;
  /** CAD dollars, e.g. "650000" or "650000.50" — converted to cents on submit. */
  contractValue: FormControl<string | null>;
  /** Date-only (yyyy-MM-dd) from the date picker. */
  contractSignedDate: FormControl<string | null>;
}

/**
 * Builder report-contract page: `/builder/report-contract`.
 *
 * When a Feasly lead signs a build contract, the builder reports it here:
 * which lead, the signed contract value (CAD, excluding land), and the
 * signing date. The backend runs attribution (12-month window), mints a
 * draft commission invoice, and starts the 7-day review window — the
 * page only collects the inputs.
 *
 * All state lives in BuilderReportContractState; the leads picker reads
 * from BuilderState. The component dispatches and renders selectors, never
 * calls the API directly.
 */
@Component({
  selector: 'app-builder-report-contract',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './builder-report-contract.component.html',
  styleUrls: ['./builder-report-contract.component.scss'],
})
export class BuilderReportContractComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly config = inject(ConfigService);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  /** Builder portal copy (config-owned). */
  protected readonly copy = this.config.get('copy').builder;

  protected readonly leads = this.store.selectSignal(BuilderState.leads);
  protected readonly leadsStatus = this.store.selectSignal(
    BuilderState.leadsStatus,
  );
  protected readonly submitStatus = this.store.selectSignal(
    BuilderReportContractState.submitStatus,
  );
  protected readonly result = this.store.selectSignal(
    BuilderReportContractState.result,
  );
  protected readonly reportedValueCents = this.store.selectSignal(
    BuilderReportContractState.reportedValueCents,
  );
  protected readonly submitError = this.store.selectSignal(
    BuilderReportContractState.error,
  );

  protected readonly form = new FormGroup<ReportContractForm>({
    leadId: new FormControl<string | null>(null, Validators.required),
    contractValue: new FormControl<string | null>(null, [
      Validators.required,
      (control) => {
        const cents = parseCadDollarsToCents(control.value);
        if (cents === null) {
          return { invalidAmount: true };
        }
        return cents > 0 ? null : { invalidAmount: true };
      },
    ]),
    contractSignedDate: new FormControl<string | null>(null, [
      Validators.required,
      (control) => {
        const value = control.value;
        if (!value) {
          return null;
        }
        return value > todayLocalDateString() ? { futureDate: true } : null;
      },
    ]),
  });

  constructor() {
    this.seo.setPage({
      title: 'Report signed contract — Feasly builder portal',
      description: this.copy.reportContractSeoDescription,
      path: '/builder/report-contract',
    });
    this.destroyRef.onDestroy(() => {
      this.store.dispatch(new ClearReportContractState());
    });
  }

  ngOnInit(): void {
    this.store.dispatch(new LoadBuilderLeads());
  }

  /** Human-readable lead label for the picker. */
  protected leadLabel(id: string): string {
    const lead = this.leads().find((l) => l.id === id);
    if (!lead) {
      return id;
    }
    return `${lead.name} — ${lead.addressKey}`;
  }

  protected isSubmitting(): boolean {
    return this.submitStatus() === 'submitting';
  }

  protected isSuccess(): boolean {
    return this.submitStatus() === 'success';
  }

  protected isError(): boolean {
    return this.submitStatus() === 'error';
  }

  /** Whether a form field's error message should show. */
  protected showFieldError(control: FormControl<string | null>): boolean {
    return control.touched && control.invalid;
  }

  /** Resolved contract-value error copy, or null when none shows. */
  protected contractValueError(): string | null {
    const control = this.form.controls.contractValue;
    if (!this.showFieldError(control)) {
      return null;
    }
    return control.hasError('required')
      ? this.copy.reportContractValueRequired
      : this.copy.reportContractValueInvalid;
  }

  /** Resolved signing-date error copy, or null when none shows. */
  protected contractSignedDateError(): string | null {
    const control = this.form.controls.contractSignedDate;
    if (!this.showFieldError(control)) {
      return null;
    }
    return control.hasError('required')
      ? this.copy.reportContractDateRequired
      : this.copy.reportContractDateFuture;
  }

  /** The 1% commission on the reported contract, formatted for display. */
  protected reportedCommission(): string {
    const cents = this.reportedValueCents();
    if (cents === null) {
      return '';
    }
    // Display-only figure; the backend computes the billed amount.
    return formatCentsToCad(onePercentOfCents(cents));
  }

  protected reportedAmount(): string {
    const cents = this.reportedValueCents();
    return cents === null ? '' : formatCentsToCad(cents);
  }

  /** Picks the confirmation copy for the backend's billing outcome. */
  protected outcomeCopy(): string {
    const outcome: ReportContractResult | null = this.result();
    if (!outcome) {
      return '';
    }
    if (outcome.billed) {
      if (outcome.reason === 'existing_invoice') {
        return this.copy.reportContractAlreadyReported;
      }
      if (outcome.reason === 'existing_disputed') {
        return this.copy.reportContractDisputed;
      }
      return this.copy.reportContractSuccessBody
        .replace('{amount}', this.reportedAmount())
        .replace('{commission}', this.reportedCommission());
    }
    switch (outcome.reason) {
      case 'flat_subscription_covers':
        return this.copy.reportContractFlatCovered;
      case 'billing_not_enabled':
        return this.copy.reportContractNotEnabled;
      default:
        return this.copy.reportContractAwaitingDetails;
    }
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid || this.isSubmitting()) {
      this.form.markAllAsTouched();
      return;
    }
    const leadId = this.form.controls.leadId.value;
    const cents = parseCadDollarsToCents(this.form.controls.contractValue.value);
    const signedDate = this.form.controls.contractSignedDate.value;
    if (leadId === null || cents === null || signedDate === null) {
      this.form.markAllAsTouched();
      return;
    }
    await firstValueFrom(
      this.store.dispatch(
        new SubmitReportContract(
          leadId,
          cents,
          dateOnlyToIsoWithOffset(signedDate),
        ),
      ),
    );
    // The error view shows the RFC 7807-surfaced message from state.
  }

  protected reportAnother(): void {
    this.form.reset();
    this.store.dispatch(new ResetReportContract());
  }
}
