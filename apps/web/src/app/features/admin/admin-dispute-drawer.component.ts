import { DIALOG_DATA } from '@angular/cdk/dialog';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { filter } from 'rxjs';
import type { DisputeDetailResponse } from '@feasly/contracts';
import {
  EntityLinkComponent,
  ErrorStateComponent,
  KeyValueListComponent,
  SkeletonComponent,
  StatusChipComponent,
  TimelineComponent,
  UiButtonComponent,
  UiConfirmService,
  UiDrawerComponent,
  UiDrawerRef,
  UiToastService,
} from '@app/shared/ui';
import { formatEdmontonDateTime } from '../../shared/utils/edmonton';
import { formatCentsToCad } from '../../shared/utils/money';
import {
  acceptConfirmOptions,
  disputeEvidenceItems,
  disputeSlaChip,
  disputeTimeline,
  rejectConfirmOptions,
} from './admin-disputes-view';
import {
  AcceptAdminDispute,
  RejectAdminDispute,
  SelectAdminDispute,
} from './admin-disputes.actions';
import { AdminDisputesState } from './admin-disputes.state';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';

export interface AdminDisputeDrawerData {
  readonly disputeId: string;
}

/** Admin invoice detail route prefix (the Invoice EntityLink target). */
const INVOICE_ROUTE = ['/admin', 'billing', 'invoices'] as const;
/** Mirrors the API's note limit (ResolveDisputeRequest). */
const NOTE_MAX_LENGTH = 2000;

/**
 * Dispute drawer (#545, admin review S12) — opened from the Disputes
 * queue with the kit Drawer (`?open=<id>`; full-height sheet on phones).
 *
 * - Header: SLA chip + opened / SLA-due meta.
 * - Summary (invoice link, builder, amounts), the IMMUTABLE evidence
 *   snapshot as a definition list, and the billing audit trail as a
 *   timeline with humanised payloads ("Contract value $980,000").
 * - Sticky footer (billing:manage only): Note + [Reject] [Accept…], both
 *   through ConfirmDialog. Accept states the void and the refund amount.
 *
 * Reads the detail from AdminDisputesState; every write is an action.
 */
@Component({
  selector: 'app-admin-dispute-drawer',
  standalone: true,
  imports: [
    UiDrawerComponent,
    UiButtonComponent,
    StatusChipComponent,
    KeyValueListComponent,
    TimelineComponent,
    EntityLinkComponent,
    SkeletonComponent,
    ErrorStateComponent,
  ],
  templateUrl: './admin-dispute-drawer.component.html',
  styleUrl: './admin-dispute-drawer.component.scss',
})
export class AdminDisputeDrawerComponent {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly confirms = inject(UiConfirmService);
  private readonly toasts = inject(UiToastService);
  private readonly ref = inject(UiDrawerRef, { optional: true });
  private readonly data = inject<AdminDisputeDrawerData>(DIALOG_DATA);

  protected readonly disputeId = this.data.disputeId;
  protected readonly noteMaxLength = NOTE_MAX_LENGTH;

  private readonly storeDetail = this.store.selectSignal(AdminDisputesState.detail);
  private readonly selectedId = this.store.selectSignal(AdminDisputesState.selectedDisputeId);
  private readonly detailStatus = this.store.selectSignal(AdminDisputesState.detailStatus);
  protected readonly detailError = this.store.selectSignal(AdminDisputesState.detailError);
  protected readonly resolving = this.store.selectSignal(AdminDisputesState.resolving);
  protected readonly resolveError = this.store.selectSignal(AdminDisputesState.resolveError);
  private readonly disputes = this.store.selectSignal(AdminDisputesState.disputes);

  /** Accept/reject are money actions (`billing:manage`). */
  protected readonly canManage = adminCan(this.store, ADMIN_PERMISSIONS.billingManage);

  /** Detail for THIS drawer only (a stale selection never renders here). */
  protected readonly detail = computed<DisputeDetailResponse | null>(() => {
    const detail = this.storeDetail();
    return detail && detail.id === this.disputeId ? detail : null;
  });

  protected readonly loading = computed(
    () => this.detail() === null && this.detailStatus() !== 'error',
  );
  protected readonly failed = computed(
    () => this.selectedId() === this.disputeId && this.detailStatus() === 'error',
  );

  /** List row while the detail loads, so the header isn't blank. */
  private readonly listItem = computed(
    () => this.disputes().find((d) => d.id === this.disputeId) ?? null,
  );

  protected readonly heading = computed(() => {
    const item = this.detail() ?? this.listItem();
    return item ? `Dispute on ${item.invoiceId}` : 'Dispute';
  });

  protected readonly sla = computed(() => {
    const item = this.detail() ?? this.listItem();
    return item ? disputeSlaChip(item) : null;
  });

  protected readonly meta = computed(() => {
    const item = this.detail() ?? this.listItem();
    if (!item) return '';
    return `Opened ${formatEdmontonDateTime(item.openedAt)} · SLA due ${formatEdmontonDateTime(item.slaDueAt)}`;
  });

  protected readonly summary = computed(() => {
    const d = this.detail();
    if (!d) return [];
    return [
      { label: 'Builder', value: d.tenantKey },
      { label: 'Commission', value: formatCentsToCad(d.commissionCents) },
      { label: 'Contract value', value: formatCentsToCad(d.contractValueCents) },
      { label: 'Reason', value: d.reason },
    ];
  });

  protected readonly evidence = computed(() => {
    const d = this.detail();
    return d ? disputeEvidenceItems(d.evidenceSnapshot) : [];
  });

  protected readonly timeline = computed(() => {
    const d = this.detail();
    return d ? disputeTimeline(d.auditTrail) : [];
  });

  /** Note draft (sent with either decision). */
  protected readonly note = signal('');
  /** An unsent note → Esc / × / scrim / Back ask first. */
  protected readonly dirty = computed(() => this.note().trim().length > 0);

  protected onNote(event: Event): void {
    this.note.set((event.target as HTMLTextAreaElement).value);
  }

  protected retry(): void {
    this.store.dispatch(new SelectAdminDispute(this.disputeId));
  }

  protected openInvoice(invoiceId: string): void {
    void this.router.navigate([...INVOICE_ROUTE, invoiceId]);
  }

  protected accept(): void {
    const d = this.detail();
    if (!d || this.resolving()) return;
    this.confirms
      .confirm(acceptConfirmOptions(d))
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() =>
        this.resolve(new AcceptAdminDispute(d.id, this.noteOrUndefined()), `Dispute accepted — invoice ${d.invoiceId} voided`),
      );
  }

  protected reject(): void {
    const d = this.detail();
    if (!d || this.resolving()) return;
    this.confirms
      .confirm(rejectConfirmOptions(d))
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() =>
        this.resolve(new RejectAdminDispute(d.id, this.noteOrUndefined()), `Dispute rejected — invoice ${d.invoiceId} back in review`),
      );
  }

  private resolve(action: AcceptAdminDispute | RejectAdminDispute, message: string): void {
    this.store
      .dispatch(action)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.note.set('');
          this.toasts.show({ message });
          this.ref?.close();
        },
        // The state records resolveError; the footer shows it.
        error: () => undefined,
      });
  }

  private noteOrUndefined(): string | undefined {
    const note = this.note().trim();
    return note === '' ? undefined : note;
  }
}
