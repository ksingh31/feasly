import { JsonPipe } from '@angular/common';
import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Store } from '@ngxs/store';
import type { DisputeListItem } from '@feasly/contracts';
import { formatCentsToCad, formatRatePercent } from '../../shared/utils/money';
import {
  AcceptAdminDispute,
  ClearSelectedAdminDispute,
  DismissAdminDisputeResolution,
  LoadAdminDisputes,
  RejectAdminDispute,
  SelectAdminDispute,
} from './admin-disputes.actions';
import { AdminDisputesState } from './admin-disputes.state';

/**
 * Dispute console (billing/01 follow-on, was OPS-009) — Karan's queue for
 * builder invoice disputes.
 *
 * Open disputes, oldest first, each with its 5-business-day resolution SLA
 * countdown on the America/Edmonton calendar. Selecting a dispute opens the
 * detail panel: the IMMUTABLE evidence snapshot (invoice money/state at
 * dispute-open time — never the live row), the billing audit trail, and the
 * accept/reject actions with an optional note.
 *
 * - Accept: voids the invoice; when it was already paid, Stripe refunds
 *   the charge first (credit note).
 * - Reject: the invoice returns to in_review with a fresh 7-day window.
 *
 * Both are audit-logged server-side. An SLA breach escalates via ops alerts
 * and NEVER auto-resolves — breached disputes stay open until a human acts.
 *
 * Guarded by `adminGuard`; noindex via the robots guard; lazy-loaded so it
 * stays out of the public initial bundle. All state lives in
 * `AdminDisputesState` — the component only dispatches actions and reads
 * signals.
 */
@Component({
  selector: 'app-admin-disputes',
  standalone: true,
  imports: [ReactiveFormsModule, JsonPipe],
  templateUrl: './admin-disputes.component.html',
  styleUrls: ['./admin-disputes.component.scss'],
})
export class AdminDisputesComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly disputes = this.store.selectSignal(AdminDisputesState.disputes);
  protected readonly listStatus = this.store.selectSignal(AdminDisputesState.listStatus);
  protected readonly listError = this.store.selectSignal(AdminDisputesState.listError);
  protected readonly selectedDisputeId = this.store.selectSignal(AdminDisputesState.selectedDisputeId);
  protected readonly detail = this.store.selectSignal(AdminDisputesState.detail);
  protected readonly detailStatus = this.store.selectSignal(AdminDisputesState.detailStatus);
  protected readonly detailError = this.store.selectSignal(AdminDisputesState.detailError);
  protected readonly resolving = this.store.selectSignal(AdminDisputesState.resolving);
  protected readonly resolveError = this.store.selectSignal(AdminDisputesState.resolveError);
  protected readonly lastResolution = this.store.selectSignal(AdminDisputesState.lastResolution);

  /** Optional admin note recorded on the dispute + audit trail. */
  protected readonly resolutionForm = this.fb.nonNullable.group({
    note: [''],
  });

  /** Two-step confirm: which action is awaiting confirmation. */
  protected confirmingAction: 'accept' | 'reject' | null = null;

  ngOnInit(): void {
    this.store.dispatch(new LoadAdminDisputes());

    // Clear any open selection when leaving the page so a stale dispute
    // doesn't linger in memory-only state.
    this.destroyRef.onDestroy(() => {
      this.store.dispatch(new ClearSelectedAdminDispute());
    });
  }

  protected reload(): void {
    this.store.dispatch(new LoadAdminDisputes());
  }

  protected selectDispute(id: string): void {
    this.confirmingAction = null;
    this.resolutionForm.reset({ note: '' });
    this.store.dispatch(new SelectAdminDispute(id));
  }

  protected closeDetail(): void {
    this.confirmingAction = null;
    this.store.dispatch(new ClearSelectedAdminDispute());
  }

  protected dismissResolution(): void {
    this.store.dispatch(new DismissAdminDisputeResolution());
  }

  protected armConfirm(action: 'accept' | 'reject'): void {
    this.confirmingAction = action;
  }

  protected cancelConfirm(): void {
    this.confirmingAction = null;
  }

  protected acceptSelected(): void {
    const id = this.selectedDisputeId();
    if (id === null) {
      return;
    }
    this.confirmingAction = null;
    this.store.dispatch(
      new AcceptAdminDispute(id, this.resolutionNoteOrUndefined()),
    );
    this.resolutionForm.reset({ note: '' });
  }

  protected rejectSelected(): void {
    const id = this.selectedDisputeId();
    if (id === null) {
      return;
    }
    this.confirmingAction = null;
    this.store.dispatch(
      new RejectAdminDispute(id, this.resolutionNoteOrUndefined()),
    );
    this.resolutionForm.reset({ note: '' });
  }

  private resolutionNoteOrUndefined(): string | undefined {
    const note = this.resolutionForm.getRawValue().note.trim();
    return note === '' ? undefined : note;
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.selectedDisputeId()) {
      this.closeDetail();
    }
  }

  // ------------------------------------------------------------------ display

  protected formatMoney(cents: number): string {
    return formatCentsToCad(cents);
  }

  /** ISO instant → America/Edmonton local time (the SLA calendar). */
  protected formatEdmonton(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    return date.toLocaleString('en-CA', {
      timeZone: 'America/Edmonton',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  /** SLA countdown label from the server-computed business days. */
  protected slaLabel(item: DisputeListItem): string {
    const remaining = item.businessDaysRemaining;
    if (remaining > 1) {
      return `${remaining} business days left`;
    }
    if (remaining === 1) {
      return '1 business day left';
    }
    if (remaining === 0) {
      return 'Due today';
    }
    const overdue = Math.abs(remaining);
    return overdue === 1 ? '1 business day overdue' : `${overdue} business days overdue`;
  }

  /** Which snapshot rows the evidence grid renders, in order. */
  protected snapshotRows(): readonly (readonly [string, string])[] {
    const detail = this.detail();
    if (detail === null) {
      return [];
    }
    const s = detail.evidenceSnapshot;
    const reviewDue = s.reviewDueAt === null ? '—' : this.formatEdmonton(s.reviewDueAt);
    return [
      ['Invoice ID', s.invoiceId],
      ['Tenant', s.tenantKey],
      ['Attribution ID', s.attributionId],
      ['Lead ID', s.leadId],
      ['Contract value (excl. land)', this.formatMoney(s.contractValueCents)],
      [`Commission (${formatRatePercent(s.effectiveRatePercent ?? 1)})`, this.formatMoney(s.commissionCents)],
      ['Currency', s.currency],
      ['Payment intent', s.stripePaymentIntentId ?? '—'],
      ['Invoice created', this.formatEdmonton(s.invoiceCreatedAt)],
      ['Disputed at', this.formatEdmonton(s.disputedAt)],
      ['Review due at', reviewDue],
      ['Dispute reason', s.disputeReason],
    ];
  }
}
