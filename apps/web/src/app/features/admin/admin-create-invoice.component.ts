import { DialogRef } from '@angular/cdk/dialog';
import { Component, DestroyRef, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { Subject, debounceTime, distinctUntilChanged, startWith } from 'rxjs';
import type { AdminLeadListItem, Builder, ManualInvoiceRequest, ManualInvoiceResponse } from '@feasly/contracts';
import {
  EntityComboboxComponent,
  EntityLinkComponent,
  type EntityOption,
  KitDateTimePipe,
  KitMoneyPipe,
  StatusChipComponent,
  UiButtonComponent,
  UiDateFieldComponent,
  UiModalComponent,
  UiMoneyFieldComponent,
  enumLabel,
} from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { formatRatePercent, percentOfCents } from '../../shared/utils/money';
import { formatInvoiceTax } from '../../shared/utils/invoice-tax';
import { todayLocalDateString } from '../../shared/utils/datetime';
import { AdminBuildersState } from './admin-builders.state';
import { LoadBuilders } from './admin-builders.actions';
import { BillingHealthState } from './billing-health.state';
import { openAdminEntity } from './admin-entity-routes';
import {
  ClearInvoiceLeads,
  CreateManualInvoice,
  DismissCreateInvoiceFeedback,
  SearchInvoiceLeads,
} from './billing-health.actions';

/**
 * Formats a local Date as ISO 8601 WITH an explicit timezone offset
 * (e.g. `2026-09-20T12:00:00-06:00`), mirroring the builder
 * report-contract contract shape.
 */
export function toIsoWithOffset(date: Date): string {
  const pad = (n: number): string => String(Math.abs(n)).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Builder name as admins know it; the tenant key is the fallback. */
export function builderName(builder: Pick<Builder, 'displayName' | 'businessName' | 'tenantKey'>): string {
  return builder.displayName || builder.businessName || builder.tenantKey;
}

/** Picker option for a builder: name, with tenant key + rate as meta. */
export function builderOption(builder: Builder): EntityOption {
  return {
    id: builder.id,
    label: builderName(builder),
    meta: `${builder.tenantKey} · ${formatRatePercent(builder.commissionRatePercent ?? 1)}`,
  };
}

/** Picker option for a lead: name (or email), with address + status as meta. */
export function leadOption(lead: AdminLeadListItem): EntityOption {
  const meta = [lead.addressKey, enumLabel(lead.status)].filter(Boolean).join(' · ');
  return { id: lead.id, label: lead.name || lead.email || lead.id, meta };
}

/**
 * Create invoice (#544, review S9) — modal content opened from the
 * Billing page header through `UiModalService`.
 *
 * Builder and lead are EntityComboboxes (no UUID paste): the builder list
 * filters locally; the lead list searches the server, scoped to the
 * chosen builder's assigned leads (the same scope the server checks).
 *
 * Two deliberate clicks for a money action: "Review invoice" shows the
 * builder, lead, contract value and the estimated commission at the
 * builder's rate → "Create invoice" dispatches. The server computes the
 * authoritative figure; the success view shows it.
 */
@Component({
  selector: 'app-admin-create-invoice',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    UiModalComponent,
    UiButtonComponent,
    EntityComboboxComponent,
    EntityLinkComponent,
    UiMoneyFieldComponent,
    UiDateFieldComponent,
    StatusChipComponent,
    KitMoneyPipe,
    KitDateTimePipe,
  ],
  templateUrl: './admin-create-invoice.component.html',
  styleUrl: './admin-create-invoice.component.scss',
})
export class AdminCreateInvoiceComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly ref = inject<DialogRef<boolean>>(DialogRef, { optional: true });
  private readonly router = inject(Router);

  protected readonly entityCopy = this.config.get('copy').admin.entities;

  readonly builders = this.store.selectSignal(AdminBuildersState.builders);
  readonly listStatus = this.store.selectSignal(AdminBuildersState.listStatus);
  readonly leads = this.store.selectSignal(BillingHealthState.invoiceLeads);
  readonly leadSearchStatus = this.store.selectSignal(BillingHealthState.invoiceLeadSearchStatus);
  readonly createStatus = this.store.selectSignal(BillingHealthState.createStatus);
  readonly createFeedback = this.store.selectSignal(BillingHealthState.createFeedback);

  /** Review/confirm step for the money action. */
  readonly reviewing = signal(false);
  /** Confirmation shown once the created invoice arrives. */
  readonly confirmedInvoice = computed<ManualInvoiceResponse | null>(() => this.createFeedback()?.invoice ?? null);
  /** #764: the created invoice's subtotal / tax / total; null when untaxed. */
  readonly confirmedTax = computed(() => {
    const invoice = this.confirmedInvoice();
    return invoice ? formatInvoiceTax(invoice, 'Tax') : null;
  });
  /** Create failure (server copy), shown inline. */
  readonly createError = computed(() => {
    const feedback = this.createFeedback();
    return feedback && !feedback.ok ? feedback.message : null;
  });

  /** Contracts can't be reported as signed in the future. */
  readonly today = todayLocalDateString();

  readonly form = new FormGroup({
    builderId: new FormControl<string | null>(null, { validators: [Validators.required] }),
    leadId: new FormControl<string | null>({ value: null, disabled: true }, { validators: [Validators.required] }),
    contractValueCents: new FormControl<number | null>(null, {
      validators: [Validators.required, Validators.min(1)],
    }),
    signedDate: new FormControl<string | null>(null, { validators: [Validators.required] }),
  });

  private readonly value = toSignal(this.form.valueChanges.pipe(startWith(this.form.getRawValue())), {
    initialValue: this.form.getRawValue(),
  });
  private readonly status = toSignal(this.form.statusChanges.pipe(startWith(this.form.status)), {
    initialValue: this.form.status,
  });

  readonly builderOptions = computed(() => this.builders().map(builderOption));
  readonly leadOptions = computed(() => this.leads().map(leadOption));

  readonly selectedBuilder = computed(() => {
    const id = this.value().builderId;
    return this.builders().find((b) => b.id === id) ?? null;
  });
  /** The picked lead, kept so its name survives a newer search. */
  readonly selectedLead = signal<EntityOption | null>(null);

  readonly selectedBuilderName = computed(() => {
    const builder = this.selectedBuilder();
    return builder ? builderName(builder) : '';
  });

  /**
   * The selected builder's negotiated rate (percent), for the review-step
   * estimate. Falls back to the 1% default — the server computes the
   * authoritative figure at creation.
   */
  readonly selectedRatePercent = computed(() => this.selectedBuilder()?.commissionRatePercent ?? 1);
  readonly selectedRateLabel = computed(() => formatRatePercent(this.selectedRatePercent()));

  /** Display-only estimate for the review step, at the selected builder's rate. */
  readonly estimatedCommissionCents = computed(() => {
    const cents = this.value().contractValueCents;
    return cents === null || cents === undefined ? null : percentOfCents(cents, this.selectedRatePercent());
  });

  readonly dateError = computed(() => {
    const date = this.value().signedDate;
    return date && date > this.today ? 'The signing date can’t be in the future.' : null;
  });

  readonly canReview = computed(() => this.status() === 'VALID' && this.dateError() === null);

  readonly leadHint = computed(() => {
    if (!this.selectedBuilder()) return 'Choose a builder first.';
    if (this.leadSearchStatus() === 'error') return 'Couldn’t load leads. Type to search again.';
    return 'Search the builder’s leads by name, email or address.';
  });

  private readonly leadQuery = new Subject<string>();

  ngOnInit(): void {
    if (this.listStatus() === 'idle') {
      this.store.dispatch(new LoadBuilders());
    }
    this.leadQuery
      .pipe(
        debounceTime(this.config.get('timings').debounceMs),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((query) => {
        const builderId = this.form.controls.builderId.value;
        if (builderId) this.store.dispatch(new SearchInvoiceLeads(builderId, query));
      });
  }

  ngOnDestroy(): void {
    this.store.dispatch([new DismissCreateInvoiceFeedback(), new ClearInvoiceLeads()]);
  }

  /** A new builder resets the lead and loads that builder's leads. */
  onBuilderChange(option: EntityOption | null): void {
    const lead = this.form.controls.leadId;
    lead.reset(null);
    this.selectedLead.set(null);
    this.store.dispatch(new ClearInvoiceLeads());
    if (option) {
      lead.enable();
      this.store.dispatch(new SearchInvoiceLeads(option.id, ''));
    } else {
      lead.disable();
    }
  }

  onLeadQuery(query: string): void {
    this.leadQuery.next(query);
  }

  onLeadChange(option: EntityOption | null): void {
    this.selectedLead.set(option);
  }

  startReview(): void {
    this.form.markAllAsTouched();
    if (!this.canReview()) return;
    this.store.dispatch(new DismissCreateInvoiceFeedback());
    this.reviewing.set(true);
  }

  backToForm(): void {
    this.reviewing.set(false);
  }

  /** The deliberate second click: dispatch the create-invoice action. */
  confirmCreate(): void {
    if (this.createStatus() === 'submitting') return;
    const { leadId, contractValueCents, signedDate } = this.form.getRawValue();
    const builder = this.selectedBuilder();
    if (!builder || !leadId || !signedDate || !contractValueCents || contractValueCents <= 0) return;
    const [year, month, day] = signedDate.split('-').map(Number);
    // Local noon: day-accurate without midnight DST-boundary shifts.
    const signedAt = new Date(year, month - 1, day, 12, 0, 0);
    const body: ManualInvoiceRequest = {
      tenantKey: builder.tenantKey,
      leadId,
      contractValueCents,
      contractSignedAt: toIsoWithOffset(signedAt),
    };
    this.store.dispatch(new CreateManualInvoice(body)).pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }

  /** EntityLink (#538): close the modal, then open the new invoice's drawer. */
  openInvoice(id: string): void {
    this.close();
    openAdminEntity(this.router, 'invoice', id);
  }

  /** Closes with `true` once an invoice was created, so the page can react. */
  close(): void {
    this.ref?.close(this.confirmedInvoice() !== null);
  }
}
