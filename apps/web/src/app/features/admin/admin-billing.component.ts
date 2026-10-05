import { DatePipe, DOCUMENT } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent } from 'rxjs';
import { Store } from '@ngxs/store';
import { RouterLink } from '@angular/router';
import type {
  BillingHealthDunningInvoice,
  BillingHealthInReviewInvoice,
} from '@feasly/contracts';
import { LoadBillingHealth, RetryInvoiceCharge } from './billing-health.actions';
import { BillingHealthState } from './billing-health.state';
import { AdminCreateInvoiceComponent } from './admin-create-invoice.component';
import {
  AdminManageInvoiceComponent,
  type ManageInvoiceInput,
} from './admin-manage-invoice.component';
import { formatCentsToCad } from '../../shared/utils/money';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';

/**
 * Focusable controls inside the manage-invoice dialog. Mirrors the
 * lead-detail modal's selector; deliberately no offsetParent filter so it
 * stays testable under jsdom, where offsetParent is always null.
 */
const MANAGE_DIALOG_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Billing-health dashboard (billing/03 follow-on — `/admin/billing`,
 * was OPS-007).
 *
 * Karan's money overview: MRR (from Stripe subscription data under the
 * flat model), commission collected in the trailing 30 days, in-review
 * invoice aging buckets (<48h / <7d / overdue), the in-review invoice
 * work queue, disputed totals, the dunning work queue with
 * `past_due_since`, and the Stripe webhook health panel.
 *
 * Mutating actions on this page (two-click confirm each):
 * - BILL-03: "Retry charge" per failed invoice.
 * - "Manage" per in-review invoice: commission-rate override or record
 *   an off-Stripe payment (mark as paid). The manage modal is also
 *   offered from dunning rows so a failed charge paid offline can be
 *   cleared. Marking paid cancels the scheduled auto-charge — the
 *   builder can never be charged twice.
 * - Manual invoice creation ("Create invoice"): builder → lead →
 *   contract value excl. land → 1% commission → 7-day review window.
 * Everything else stays read-only.
 * Status badges always pair a text label with color, never color alone.
 *
 * noindex,nofollow via the robots guard on the parent admin route; excluded
 * from prerendering like all admin pages.
 */
@Component({
  selector: 'app-admin-billing',
  standalone: true,
  imports: [DatePipe, RouterLink, AdminCreateInvoiceComponent, AdminManageInvoiceComponent],
  templateUrl: './admin-billing.component.html',
  styleUrl: './admin-billing.component.scss',
})
export class AdminBillingComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly health = this.store.selectSignal(BillingHealthState.health);
  protected readonly loadStatus = this.store.selectSignal(
    BillingHealthState.loadStatus,
  );
  protected readonly error = this.store.selectSignal(BillingHealthState.error);
  protected readonly hasDunning = this.store.selectSignal(
    BillingHealthState.hasDunning,
  );
  protected readonly hasWebhookIssues = this.store.selectSignal(
    BillingHealthState.hasWebhookIssues,
  );
  /** Invoice id currently retrying its charge, or null. BILL-03. */
  protected readonly retryingInvoiceId = this.store.selectSignal(
    BillingHealthState.retryingInvoiceId,
  );
  /** One-shot retry feedback shown in the dunning queue. BILL-03. */
  protected readonly retryFeedback = this.store.selectSignal(
    BillingHealthState.retryFeedback,
  );

  /**
   * Write-action gating (display only — the backend 403s without
   * `billing:manage`): create invoice, manage (mark paid / rate override),
   * and charge retries render only for sessions that can use them.
   * Read-only staff see the money overview without the action buttons.
   */
  protected readonly canManageBilling = adminCan(
    this.store,
    ADMIN_PERMISSIONS.billingManage,
  );

  /** Invoice awaiting the second (confirm) click of the retry flow. */
  private confirmRetryId: string | null = null;

  /** Whether the manual-invoice creation form is open. */
  protected readonly showCreateForm = signal(false);

  /** Invoice open in the manage modal, or null. */
  protected readonly managedInvoice = signal<ManageInvoiceInput | null>(null);

  private readonly document = inject(DOCUMENT);
  private readonly cdr = inject(ChangeDetectorRef);

  /** The manage dialog wrapper (role=dialog); present only while open. */
  private readonly manageDialog =
    viewChild<ElementRef<HTMLElement>>('manageDialog');

  /** Button that opened the manage dialog — focus returns here on close. */
  private manageInvoker: HTMLElement | null = null;

  constructor() {
    // Esc must close the dialog wherever focus is (a keydown binding on
    // the dialog div only fired when focus was already inside — which
    // never happened on open), and Tab must cycle inside the dialog
    // while it is open. One document-level listener, no-op when closed.
    fromEvent<KeyboardEvent>(this.document, 'keydown')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.onManageDialogKeydown(event));
  }

  ngOnInit(): void {
    this.store
      .dispatch(new LoadBillingHealth())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Manual refresh — the panel reloads from the server. */
  protected refresh(): void {
    this.store
      .dispatch(new LoadBillingHealth())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Open/close the manual-invoice creation form. */
  protected openCreateForm(): void {
    this.showCreateForm.set(true);
  }

  protected closeCreateForm(): void {
    this.showCreateForm.set(false);
  }

  /** Open the manage modal for an in-review invoice. */
  protected openManageInReview(
    invoice: BillingHealthInReviewInvoice,
    event?: Event,
  ): void {
    this.captureManageInvoker(event);
    this.managedInvoice.set({
      id: invoice.id,
      tenantKey: invoice.tenantKey,
      commissionCents: invoice.commissionCents,
      currency: invoice.currency,
      commissionRatePercent: invoice.commissionRatePercent,
      contractValueCents: invoice.contractValueCents,
      paymentMethod: invoice.paymentMethod,
      reviewDueAt: invoice.reviewDueAt,
      status: 'in_review',
    });
    this.finalizeManageOpen();
  }

  /** Open the manage modal from a dunning row (failed charge paid offline). */
  protected openManageDunning(
    invoice: BillingHealthDunningInvoice,
    event?: Event,
  ): void {
    this.captureManageInvoker(event);
    this.managedInvoice.set({
      id: invoice.id,
      tenantKey: invoice.tenantKey,
      commissionCents: invoice.commissionCents,
      currency: invoice.currency,
      contractValueCents: invoice.contractValueCents,
      commissionRatePercent: invoice.commissionRatePercent,
      paymentMethod: invoice.paymentMethod,
      reviewDueAt: null,
      status: 'failed',
    });
    this.finalizeManageOpen();
  }

  /**
   * Render the freshly opened dialog and move focus into it, synchronously
   * (no timer — deterministic in tests and immediate for screen readers).
   */
  private finalizeManageOpen(): void {
    this.cdr.detectChanges();
    this.focusFirstInManageDialog();
  }

  /**
   * Remember the button that opened the dialog so focus can return to it
   * on close. currentTarget (not activeElement) is the reliable source —
   * Safari doesn't move focus to buttons on mouse click.
   */
  private captureManageInvoker(event?: Event): void {
    const target = event?.currentTarget;
    this.manageInvoker = target instanceof HTMLElement ? target : null;
  }

  /** Close the manage modal — every close path funnels through here. */
  protected closeManage(): void {
    this.managedInvoice.set(null);
    const invoker = this.manageInvoker;
    this.manageInvoker = null;
    // The work queue can re-render while the dialog is open (health
    // reloads after a successful action); only restore focus when the
    // invoking button is still in the document.
    if (invoker && this.document.contains(invoker)) {
      invoker.focus();
    }
  }

  /** Document-level keydown while the manage dialog is open. */
  private onManageDialogKeydown(event: KeyboardEvent): void {
    if (!this.managedInvoice()) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeManage();
      return;
    }
    if (event.key === 'Tab') {
      this.trapManageDialogTab(event);
    }
  }

  /** Focus the dialog's first control (the @if block has rendered). */
  private focusFirstInManageDialog(): void {
    if (!this.managedInvoice()) {
      return;
    }
    const dialog = this.manageDialog()?.nativeElement;
    if (!dialog) {
      return;
    }
    const first = this.manageDialogFocusables()[0];
    if (first) {
      first.focus();
    } else {
      // No focusable control yet — make the dialog itself the target.
      dialog.setAttribute('tabindex', '-1');
      dialog.focus();
    }
  }

  /** Keep Tab / Shift+Tab cycling inside the open dialog. */
  private trapManageDialogTab(event: KeyboardEvent): void {
    const dialog = this.manageDialog()?.nativeElement;
    if (!dialog) {
      return;
    }
    const focusables = this.manageDialogFocusables();
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = this.document.activeElement as HTMLElement | null;
    if (!active || !dialog.contains(active)) {
      // Focus escaped the dialog somehow — pull it back in.
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private manageDialogFocusables(): HTMLElement[] {
    const dialog = this.manageDialog()?.nativeElement;
    if (!dialog) {
      return [];
    }
    return Array.from(
      dialog.querySelectorAll<HTMLElement>(MANAGE_DIALOG_FOCUSABLE),
    );
  }

  /**
   * BILL-03 retry flow. First click arms the confirm state ("Retry charge"
   * becomes "Confirm retry"); the second click dispatches. A charge retry
   * is a real money action, so it always requires the deliberate second
   * click — never a single tap.
   */
  protected requestRetry(invoiceId: string): void {
    this.confirmRetryId = invoiceId;
  }

  protected cancelRetry(): void {
    this.confirmRetryId = null;
  }

  protected isConfirming(invoiceId: string): boolean {
    return this.confirmRetryId === invoiceId;
  }

  protected confirmRetry(invoiceId: string): void {
    this.confirmRetryId = null;
    this.store
      .dispatch(new RetryInvoiceCharge(invoiceId))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /**
   * "Retry 2 of 3" — the next attempt number against the cap from the
   * health payload. Falls back to a plain label when the cap is unknown.
   */
  protected retryButtonLabel(
    retryCount: number,
    maxRetries: number | undefined,
  ): string {
    if (maxRetries === undefined || maxRetries <= 0) return 'Retry charge';
    return `Retry ${Math.min(retryCount + 1, maxRetries)} of ${maxRetries}`;
  }

  /** True when the invoice has used all its charge retries. */
  protected retriesExhausted(
    retryCount: number,
    maxRetries: number | undefined,
  ): boolean {
    return maxRetries !== undefined && retryCount >= maxRetries;
  }

  protected formatCents(cents: number | null): string {
    if (cents === null) return '—';
    return formatCentsToCad(cents);
  }

  /** "1.5%" — trims float dust from stored percents. */
  protected formatRatePercent(rate: number): string {
    return `${Number(rate.toFixed(4))}%`;
  }

  /**
   * Whole days between now and an ISO timestamp (dunning age). Integer
   * math on the epoch — no float rounding surprises.
   */
  protected daysOverdue(iso: string): number {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return 0;
    return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
  }

  protected modelLabel(model: 'commission' | 'flat'): string {
    // The commission model now bills at each builder's negotiated rate
    // (default 1%) — the badge names the model, not a single rate.
    return model === 'commission' ? 'Commission' : 'Flat plan';
  }
}
