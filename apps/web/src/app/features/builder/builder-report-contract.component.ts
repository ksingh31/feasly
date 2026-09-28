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
import { formatCentsToCad } from '../../shared/utils/money';
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
 * Parse a CAD dollars string into integer cents with integer math only
 * (no float multiplication — "650000.50" -> 65000050).
 * Returns null when the input is not a valid dollars amount.
 */
export function parseCadDollarsToCents(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim().replace(/[$,\s]/g, '');
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const dollars = Number(match[1]);
  const frac = (match[2] ?? '').padEnd(2, '0');
  return dollars * 100 + Number(frac);
}

/**
 * Compose a full ISO-8601 datetime with the LOCAL timezone offset from a
 * date-only picker value — the backend's zod schema requires an explicit
 * offset (`z.string().datetime({ offset: true })`).
 * "2026-09-28" -> "2026-09-28T00:00:00-06:00" (offset varies by locale).
 */
export function dateOnlyToIsoWithOffset(dateOnly: string): string {
  const probe = new Date(`${dateOnly}T00:00:00`);
  const offsetMin = -probe.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${dateOnly}T00:00:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
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
        return value > todayLocalDate() ? { futureDate: true } : null;
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

  /** The 1% commission on the reported contract, formatted for display. */
  protected reportedCommission(): string {
    const cents = this.reportedValueCents();
    if (cents === null) {
      return '';
    }
    // Display-only figure; the backend computes the billed amount.
    return formatCentsToCad(Math.round(cents / 100));
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

/** Today's local date as yyyy-MM-dd (for the no-future-date validator). */
function todayLocalDate(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
