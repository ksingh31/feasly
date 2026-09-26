import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { Store } from '@ngxs/store';
import type { AdminLeadStatus } from '@feasly/contracts';
import { formatCentsRangeToCad, formatCentsToCad } from '../../shared/utils/money';
import {
  AddAdminLeadNote,
  ClearSelectedAdminLead,
  SelectAdminLead,
  UpdateAdminLeadStatus,
} from './admin-leads.actions';
import { AdminLeadsState } from './admin-leads.state';

/** Pipeline statuses in the order Karan works them. */
const PIPELINE_STATUSES: readonly AdminLeadStatus[] = [
  'new',
  'contacted',
  'quoting',
  'won',
  'lost',
];

/**
 * Lead detail drawer (admin/02).
 *
 * Shows the full detail for the selected lead: estimate summary (dollar
 * ranges rendered from integer cents — no float math), timeline, consent,
 * magic-link status, Sheets sync, snapshot count, tenant attribution,
 * source, the append-only notes thread, and the pipeline status control.
 *
 * Rendered by `AdminLeadsComponent` when a lead is selected.
 */
@Component({
  selector: 'app-admin-lead-detail',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './admin-lead-detail.component.html',
  styleUrls: ['./admin-leads.component.scss'],
})
export class AdminLeadDetailComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly detail = this.store.selectSignal(AdminLeadsState.detail);
  protected readonly detailStatus = this.store.selectSignal(AdminLeadsState.detailStatus);
  protected readonly detailError = this.store.selectSignal(AdminLeadsState.detailError);
  protected readonly notePosting = this.store.selectSignal(AdminLeadsState.notePosting);
  protected readonly statusUpdating = this.store.selectSignal(AdminLeadsState.statusUpdating);

  protected readonly noteControl = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(5000)],
  });
  protected readonly statusControl = new FormControl<AdminLeadStatus>('new', {
    nonNullable: true,
  });

  protected readonly pipelineStatuses = PIPELINE_STATUSES;

  ngOnInit(): void {
    // Keep the status dropdown in sync when the detail loads/changes.
    this.store
      .select(AdminLeadsState.detail)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((detail) => {
        if (detail) {
          this.statusControl.setValue(detail.status, { emitEvent: false });
        }
      });
  }

  protected close(): void {
    this.store.dispatch(new ClearSelectedAdminLead());
  }

  protected addNote(): void {
    const detail = this.detail();
    const note = this.noteControl.value.trim();
    if (!detail || note.length === 0 || this.notePosting()) {
      return;
    }
    this.store
      .dispatch(new AddAdminLeadNote(detail.id, note))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.noteControl.reset(),
      });
  }

  protected changeStatus(): void {
    const detail = this.detail();
    const status = this.statusControl.value;
    if (!detail || status === detail.status || this.statusUpdating()) {
      return;
    }
    this.store.dispatch(new UpdateAdminLeadStatus(detail.id, status));
  }

  protected retry(): void {
    const retryId = this.store.selectSnapshot(AdminLeadsState.selectedLeadId);
    if (retryId) {
      this.store.dispatch(new SelectAdminLead(retryId));
    }
  }

  /** Integer-cents → CAD dollars (no float math). */
  protected cad(cents: number): string {
    return formatCentsToCad(cents);
  }

  /** Integer-cents range → "$low – $high". */
  protected cadRange(range: readonly [number, number]): string {
    return formatCentsRangeToCad(range);
  }

  protected formatDate(iso: string | null): string {
    if (!iso) {
      return '—';
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-CA');
  }

  protected magicLinkLabel(status: string): string {
    switch (status) {
      case 'sent':
        return 'Sent';
      case 'used':
        return 'Used';
      case 'expired':
        return 'Expired';
      default:
        return 'None';
    }
  }
}
