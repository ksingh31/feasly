import {
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { firstValueFrom } from 'rxjs';
import type { BuilderLeadListItem } from '@feasly/contracts';
import { BUILDER_COPY } from './builder-copy';
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
 * Builder record-contract page: `/builder/record-contract`.
 *
 * When a Feasly lead signs a build contract, the builder records it here:
 * which lead, the signed contract value (CAD, excluding land), and the
 * signing date. The backend runs attribution (12-month window), mints a
 * draft commission invoice, and starts the 7-day review window — the
 * page only collects the inputs.
 *
 * One contract per lead: the picker lists only leads without an invoice.
 * Opening the page for an already-recorded lead (e.g. via a stale link)
 * shows the invoice status card instead of the form — there is no
 * resubmit path, so a duplicate report is impossible from the UI. The
 * backend stays idempotent per lead as the backstop.
 *
 * All state lives in BuilderReportContractState; the leads picker reads
 * from BuilderState. The component dispatches and renders selectors, never
 * calls the API directly.
 */
@Component({
  selector: 'app-builder-report-contract',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './builder-report-contract.component.html',
  styleUrls: ['./builder-report-contract.component.scss'],
})
export class BuilderReportContractComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly seo = inject(SeoService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(BUILDER_COPY);

  /**
   * Commission-panel money formatting: the shared money util renders whole
   * dollars without cents ("$6,500"), but the panel's empty state must read
   * "$0.00" per the approved flow. Zero is the only case that differs.
   * The zero figure is config-owned copy.
   */
  private formatCadFigure(cents: number): string {
    return cents === 0
      ? this.copy.recordContractZeroCommission
      : formatCentsToCad(cents);
  }

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
  protected readonly invoice = this.store.selectSignal(
    BuilderReportContractState.invoice,
  );
  protected readonly submitError = this.store.selectSignal(
    BuilderReportContractState.error,
  );

  /** Leads that can still be recorded: no commission invoice yet. */
  protected readonly reportableLeads = computed<readonly BuilderLeadListItem[]>(
    () => this.leads().filter((lead) => !lead.hasInvoice),
  );

  /**
   * The currently selected lead's id, mirrored into a signal so the
   * already-recorded state reacts to picker changes too.
   */
  protected readonly selectedLeadId = signal<string | null>(null);

  /** The currently selected lead, or null when nothing is selected. */
  protected readonly selectedLead = computed<BuilderLeadListItem | null>(() => {
    const id = this.selectedLeadId();
    if (!id) {
      return null;
    }
    return this.leads().find((l) => l.id === id) ?? null;
  });

  /**
   * The currently selected lead's invoice summary, when it has one. The
   * picker filters recorded leads out, so this only fires for a stale
   * `?lead=` link — it drives the already-recorded state.
   */
  protected readonly selectedInvoiceSummary = computed(
    () => this.selectedLead()?.invoiceSummary ?? null,
  );

  /** Whether the selected lead is already recorded (no form, no resubmit). */
  protected readonly isAlreadyRecorded = computed(
    () => this.selectedInvoiceSummary() !== null,
  );

  /**
   * Always-visible 1% commission figure, recomputed as the builder types.
   * Starts at $0.00 — the figure is never hidden behind a validity gate.
   * Display-only; the backend computes the billed amount.
   */
  protected readonly liveCommissionCents = signal(0);
  protected readonly liveCommission = computed(() =>
    this.formatCadFigure(onePercentOfCents(this.liveCommissionCents())),
  );
  /** The typed contract value in cents (for the commission panel breakdown). */
  protected readonly liveContractValue = computed(() =>
    this.formatCadFigure(this.liveCommissionCents()),
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
      title: 'Record signed contract — Feasly builder portal',
      description: this.copy.reportContractSeoDescription,
      path: '/builder/record-contract',
    });
    this.destroyRef.onDestroy(() => {
      this.store.dispatch(new ClearReportContractState());
    });
    this.form.controls.contractValue.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => {
        const cents = parseCadDollarsToCents(value);
        this.liveCommissionCents.set(
          cents !== null && cents > 0 ? cents : 0,
        );
      });
    this.form.controls.leadId.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((leadId) => {
        this.selectedLeadId.set(leadId);
      });
  }

  ngOnInit(): void {
    this.store.dispatch(new LoadBuilderLeads());
    // The lead-card CTA passes the lead id: pre-select it so the builder
    // doesn't pick the lead twice. A recorded lead resolves to the
    // already-recorded state instead of the form.
    const leadId = this.route.snapshot.queryParamMap.get('lead');
    if (leadId) {
      this.form.controls.leadId.setValue(leadId);
      this.selectedLeadId.set(leadId);
    }
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

  /** Re-submits the report after an API failure (the form is still valid). */
  protected retrySubmit(): Promise<void> {
    return this.submit();
  }

  /** Reloads the lead picker after a leads fetch failure. */
  protected reloadLeads(): void {
    this.store.dispatch(new LoadBuilderLeads());
  }

  /** ISO instant → America/Edmonton medium date (the billing calendar). */
  protected formatEdmontonDate(iso: string | null): string {
    if (!iso) {
      return '—';
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    return date.toLocaleDateString('en-CA', {
      timeZone: 'America/Edmonton',
      dateStyle: 'medium',
    });
  }

  /**
   * Day-level auto-charge countdown on the America/Edmonton calendar,
   * counted from the invoice's review deadline. Returns null when there
   * is no review deadline.
   */
  protected autoChargeCountdown(reviewDueAt: string | null): string | null {
    if (!reviewDueAt) {
      return null;
    }
    const due = new Date(reviewDueAt);
    if (Number.isNaN(due.getTime())) {
      return null;
    }
    const dayFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Edmonton',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const days =
      Math.round(
        (Date.parse(dayFmt.format(due)) - Date.parse(dayFmt.format(new Date()))) /
          86_400_000,
      );
    if (days < 0) {
      return null;
    }
    if (days === 0) {
      return this.copy.invoicesAutoChargeToday;
    }
    if (days === 1) {
      return this.copy.invoicesAutoChargeTomorrow;
    }
    return this.copy.invoicesAutoChargeIn.replace('{days}', String(days));
  }

  /** Integer cents → "$12,345" (shared money util, integer math only). */
  protected money(cents: number): string {
    return formatCentsToCad(cents);
  }
}
