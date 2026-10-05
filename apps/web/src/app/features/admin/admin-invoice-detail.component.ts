import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { map } from 'rxjs/operators';
import { formatCentsToCad } from '../../shared/utils/money';
import {
  ClearAdminInvoiceDetail,
  DismissAdminInvoiceDetailError,
  LoadAdminInvoiceDetail,
} from './admin-invoices.actions';
import { AdminInvoicesState } from './admin-invoices.state';
import {
  AdminManageInvoiceComponent,
  type ManageInvoiceInput,
} from './admin-manage-invoice.component';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';

/**
 * Standalone admin invoice detail page (QA admin-console fix 3).
 *
 * The full invoice record — amounts, rate breakdown, payment method,
 * lifecycle timestamps, dispute context — for any invoice, including
 * paid ones unreachable from the billing work queues. The Manage action
 * (mark-paid / rate override / payment method) reuses the billing page's
 * `AdminManageInvoiceComponent` and is gated to `billing:manage` holders
 * on actionable statuses only (in_review / failed).
 *
 * Route: `/admin/billing/invoices/:id`, inside the admin shell.
 */
@Component({
  selector: 'app-admin-invoice-detail',
  standalone: true,
  imports: [DatePipe, RouterLink, AdminManageInvoiceComponent],
  templateUrl: './admin-invoice-detail.component.html',
  styleUrl: './admin-invoice-detail.component.scss',
})
export class AdminInvoiceDetailComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly detail = this.store.selectSignal(AdminInvoicesState.detail);
  protected readonly detailStatus = this.store.selectSignal(
    AdminInvoicesState.detailStatus,
  );
  protected readonly detailError = this.store.selectSignal(
    AdminInvoicesState.detailError,
  );

  /**
   * Manage is a `billing:manage` write (display only — the backend 403s
   * without it). Read-only staff see the detail without the action.
   */
  protected readonly canManageBilling = adminCan(
    this.store,
    ADMIN_PERMISSIONS.billingManage,
  );

  /** The invoice currently open in the manage modal, or null. */
  protected readonly managedInvoice = signal<ManageInvoiceInput | null>(null);

  ngOnInit(): void {
    this.route.paramMap
      .pipe(
        map((params) => params.get('id')),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((id) => {
        if (id !== null) {
          this.store.dispatch(new LoadAdminInvoiceDetail(id));
        }
      });

    // Clear the detail when leaving the page so a stale invoice doesn't
    // linger in memory-only state.
    this.destroyRef.onDestroy(() => {
      this.store.dispatch(new ClearAdminInvoiceDetail());
    });
  }

  /** Whether the loaded invoice can be managed (modal supports these). */
  protected canManageInvoice(): boolean {
    const invoice = this.detail();
    return (
      this.canManageBilling() &&
      invoice !== null &&
      (invoice.status === 'in_review' || invoice.status === 'failed')
    );
  }

  protected openManage(): void {
    const invoice = this.detail();
    // Narrow the status inline so the modal's input type checks: the
    // manage modal only supports in_review / failed invoices.
    if (
      invoice === null ||
      !this.canManageBilling() ||
      (invoice.status !== 'in_review' && invoice.status !== 'failed')
    ) {
      return;
    }
    this.managedInvoice.set({
      id: invoice.id,
      tenantKey: invoice.tenantKey,
      commissionCents: invoice.commissionCents,
      currency: invoice.currency,
      commissionRatePercent:
        invoice.commissionRatePercent ?? invoice.effectiveRatePercent,
      contractValueCents: invoice.contractValueCents,
      paymentMethod: invoice.paymentMethod,
      reviewDueAt: invoice.reviewDueAt,
      status: invoice.status,
    });
  }

  protected closeManage(): void {
    this.managedInvoice.set(null);
    // Refresh the detail — a mark-paid or rate override changes it.
    const invoice = this.detail();
    if (invoice !== null) {
      this.store.dispatch(new LoadAdminInvoiceDetail(invoice.id));
    }
  }

  protected retry(): void {
    const invoice = this.detail();
    const id =
      invoice?.id ?? this.route.snapshot.paramMap.get('id');
    if (id !== null) {
      this.store.dispatch(new LoadAdminInvoiceDetail(id));
    }
  }

  protected dismissError(): void {
    this.store.dispatch(new DismissAdminInvoiceDetailError());
  }

  protected formatCents(cents: number): string {
    return formatCentsToCad(cents);
  }

  protected formatRate(ratePercent: number): string {
    return `${ratePercent.toFixed(2)}%`;
  }

  protected statusLabel(status: string): string {
    return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  protected paymentMethodLabel(method: string): string {
    return method.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}
