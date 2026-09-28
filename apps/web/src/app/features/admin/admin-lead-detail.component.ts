import { DOCUMENT } from '@angular/common';
import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { Store } from '@ngxs/store';
import type { AdminLeadStatus } from '@feasly/contracts';
import { formatCentsRangeToCad, formatCentsToCad } from '../../shared/utils/money';
import { initials } from '../../shared/utils/initials';
import {
  AddAdminLeadNote,
  ClearSelectedAdminLead,
  DismissAdminLeadNoteError,
  DismissAdminLeadStatusError,
  DismissAdminLeadStatusSuccess,
  SelectAdminLead,
  UpdateAdminLeadStatus,
} from './admin-leads.actions';
import { AdminLeadsState } from './admin-leads.state';
import {
  AssignLeadBuilder,
  DismissAssignBuilderError,
  DismissAssignBuilderSuccess,
  LoadBuilders,
} from './admin-builders.actions';
import { AdminBuildersState } from './admin-builders.state';

/** Pipeline statuses in the order Karan works them. */
const PIPELINE_STATUSES: readonly AdminLeadStatus[] = [
  'new',
  'contacted',
  'quoting',
  'won',
  'lost',
];

/** Focusable elements for the modal focus trap. */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Lead detail modal (admin/02) — FE-9 redesign.
 *
 * Centered modal (near-full-screen sheet on mobile) replacing the old side
 * drawer: header (avatar, name, email · phone, close), Pipeline card with
 * the dropdown + Apply Status flow, Contact grid, Property & estimate,
 * Activity timeline, Notes, and a Record meta section (no data loss vs the
 * old drawer).
 *
 * Status changes are deliberately two-step (Karan's requirement): pick a
 * status in the dropdown, then Apply Status. The button stays disabled
 * until the selection differs from the lead's current status.
 *
 * Assign-to-builder is two-step like status (Karan's requirement): pick a
 * builder in the dropdown, then Apply Builder. The button stays disabled
 * until the selection differs from the lead's current assignment, and the
 * detail is refetched after apply so the modal reflects the updated
 * assignment. Both applies show an inline success confirmation; the refetch
 * keeps the open detail on screen (no loading flash), and refresh failures
 * surface inline instead of wiping the modal.
 */
@Component({
  selector: 'app-admin-lead-detail',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './admin-lead-detail.component.html',
  styleUrls: ['./admin-lead-detail.component.scss'],
  host: {
    '(keydown)': 'onKeydown($event)',
  },
})
export class AdminLeadDetailComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly elementRef = inject(ElementRef);
  private readonly document = inject(DOCUMENT);

  protected readonly detail = this.store.selectSignal(AdminLeadsState.detail);
  protected readonly detailStatus = this.store.selectSignal(AdminLeadsState.detailStatus);
  protected readonly detailError = this.store.selectSignal(AdminLeadsState.detailError);
  protected readonly detailRefreshError = this.store.selectSignal(
    AdminLeadsState.detailRefreshError,
  );
  protected readonly notePosting = this.store.selectSignal(AdminLeadsState.notePosting);
  protected readonly noteError = this.store.selectSignal(AdminLeadsState.noteError);
  protected readonly statusUpdating = this.store.selectSignal(AdminLeadsState.statusUpdating);
  protected readonly statusUpdateError = this.store.selectSignal(AdminLeadsState.statusUpdateError);
  protected readonly statusUpdateSuccess = this.store.selectSignal(
    AdminLeadsState.statusUpdateSuccess,
  );

  /** Builders table (for the assign dropdown). */
  protected readonly builders = this.store.selectSignal(AdminBuildersState.builders);
  protected readonly buildersStatus = this.store.selectSignal(AdminBuildersState.listStatus);
  protected readonly assigning = this.store.selectSignal(AdminBuildersState.assigning);
  protected readonly assignError = this.store.selectSignal(AdminBuildersState.assignError);
  protected readonly assignSuccess = this.store.selectSignal(AdminBuildersState.assignSuccess);

  protected readonly noteControl = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(5000)],
  });
  protected readonly statusControl = new FormControl<AdminLeadStatus>('new', {
    nonNullable: true,
  });

  /**
   * Builder assignment: '' = unassigned, otherwise the builder id. Two-step
   * like the status flow — the dropdown holds a pending pick and Apply
   * Builder commits it, so a misclick can't reassign the lead.
   */
  protected readonly builderControl = new FormControl<string>('', { nonNullable: true });

  /** Mirrors the dropdown so the template can react without a method call. */
  protected readonly selectedStatus = signal<AdminLeadStatus>('new');

  /** Mirrors the builder dropdown's pending pick (committed by Apply Builder). */
  protected readonly selectedBuilderId = signal<string>('');

  protected readonly pipelineStatuses = PIPELINE_STATUSES;

  /** Apply Status is enabled only when the pick differs from current status. */
  protected readonly canApply = computed(() => {
    const detail = this.detail();
    return (
      detail !== null &&
      this.selectedStatus() !== detail.status &&
      !this.statusUpdating()
    );
  });

  /** Apply Builder is enabled only when the pick differs from the current assignment. */
  protected readonly canApplyBuilder = computed(() => {
    const detail = this.detail();
    return (
      detail !== null &&
      this.selectedBuilderId() !== (detail.builderId ?? '') &&
      !this.assigning()
    );
  });

  /** Display name of the builder the lead is currently assigned to (null when unassigned). */
  protected readonly assignedBuilderName = computed(() => {
    const detail = this.detail();
    if (!detail || !detail.builderId) {
      return null;
    }
    return this.builders().find((b) => b.id === detail.builderId)?.displayName ?? null;
  });

  /** Inline confirmation after a successful status apply. */
  protected readonly statusSuccessMessage = computed(() => {
    const detail = this.detail();
    return detail
      ? `Status updated to ${this.statusLabel(detail.status)}.`
      : 'Status updated.';
  });

  /** Inline confirmation after a successful builder apply. */
  protected readonly assignSuccessMessage = computed(() => {
    const name = this.assignedBuilderName();
    return name ? `Assigned to ${name}.` : 'Builder unassigned.';
  });

  /** Element that had focus before the modal opened — restored on close. */
  private previousFocus: Element | null = null;

  ngOnInit(): void {
    this.previousFocus = this.document.activeElement;

    // Fresh builders list each time the modal opens — the dropdown needs
    // the current table (names can change under us).
    this.store.dispatch(new LoadBuilders());

    // Keep the status dropdown in sync when the detail loads/changes
    // (including the optimistic-update rollback on a failed apply).
    this.store
      .select(AdminLeadsState.detail)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((detail) => {
        if (detail) {
          this.statusControl.setValue(detail.status, { emitEvent: false });
          this.selectedStatus.set(detail.status);
          this.builderControl.setValue(detail.builderId ?? '', { emitEvent: false });
          this.selectedBuilderId.set(detail.builderId ?? '');
        }
      });

    this.statusControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((status) => {
        this.selectedStatus.set(status);
        // A fresh pick dismisses the previous apply feedback.
        if (this.statusUpdateError()) {
          this.store.dispatch(new DismissAdminLeadStatusError());
        }
        if (this.statusUpdateSuccess()) {
          this.store.dispatch(new DismissAdminLeadStatusSuccess());
        }
      });

    this.builderControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((builderId) => {
        this.selectedBuilderId.set(builderId);
        // A fresh pick dismisses the previous apply feedback.
        if (this.assignError()) {
          this.store.dispatch(new DismissAssignBuilderError());
        }
        if (this.assignSuccess()) {
          this.store.dispatch(new DismissAssignBuilderSuccess());
        }
      });

    // Typing a new note dismisses the previous note-post error.
    this.noteControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.noteError()) {
          this.store.dispatch(new DismissAdminLeadNoteError());
        }
      });
  }

  ngAfterViewInit(): void {
    // Move focus into the modal; the focus trap keeps it there.
    this.closeButton()?.focus();
  }

  ngOnDestroy(): void {
    // Return focus where it was so keyboard users don't lose their place.
    if (this.previousFocus instanceof HTMLElement) {
      this.previousFocus.focus();
    }
  }

  protected close(): void {
    this.store.dispatch(new ClearSelectedAdminLead());
  }

  /** Esc closes; Tab cycles inside the modal (focus trap). */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = this.focusableElements();
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = this.document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private focusableElements(): HTMLElement[] {
    const root: HTMLElement = this.elementRef.nativeElement;
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => el.offsetParent !== null,
    );
  }

  private closeButton(): HTMLElement | null {
    const root: HTMLElement = this.elementRef.nativeElement;
    return root.querySelector<HTMLElement>('.lead-modal-card__close');
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

  /** Two-step status change: only fires from the Apply Status button. */
  protected applyStatus(): void {
    const detail = this.detail();
    const status = this.statusControl.value;
    if (!detail || status === detail.status || this.statusUpdating()) {
      return;
    }
    // Keep the pipeline feedback focused on the latest action.
    if (this.assignSuccess()) {
      this.store.dispatch(new DismissAssignBuilderSuccess());
    }
    this.store.dispatch(new UpdateAdminLeadStatus(detail.id, status));
  }

  /**
   * Two-step builder assignment: only fires from the Apply Builder button.
   * On completion the detail is refetched so the modal reflects the updated
   * assignment; a failed assign rolls the dropdown back to the server-side
   * value via that same refetch.
   */
  protected applyBuilder(): void {
    const detail = this.detail();
    const picked = this.selectedBuilderId();
    const next = picked === '' ? null : picked;
    if (!detail || next === (detail.builderId ?? null) || this.assigning()) {
      return;
    }
    // A fresh apply dismisses the previous assign feedback.
    if (this.assignError()) {
      this.store.dispatch(new DismissAssignBuilderError());
    }
    if (this.statusUpdateSuccess()) {
      this.store.dispatch(new DismissAdminLeadStatusSuccess());
    }
    this.store
      .dispatch(new AssignLeadBuilder(detail.id, next))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // Refetch so the modal reflects the server-side assignment. On a
        // failed assign this also rolls the dropdown back to the stored
        // value; the failure itself lives in state (assignError).
        next: () => this.store.dispatch(new SelectAdminLead(detail.id)),
        error: () => this.store.dispatch(new SelectAdminLead(detail.id)),
      });
  }

  protected retry(): void {
    const retryId = this.store.selectSnapshot(AdminLeadsState.selectedLeadId);
    if (retryId) {
      this.store.dispatch(new SelectAdminLead(retryId));
    }
  }

  protected initials(name: string): string {
    return initials(name);
  }

  protected statusLabel(status: AdminLeadStatus): string {
    return status.charAt(0).toUpperCase() + status.slice(1);
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
