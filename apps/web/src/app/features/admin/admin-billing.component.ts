import { DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import { LoadBillingHealth, RetryInvoiceCharge } from './billing-health.actions';
import { BillingHealthState } from './billing-health.state';
import { formatCentsToCad } from '../../shared/utils/money';

/**
 * Billing-health dashboard (billing/03 follow-on — `/admin/billing`,
 * was OPS-007).
 *
 * Karan's money overview: MRR (from Stripe subscription data under the
 * flat model), commission collected in the trailing 30 days, in-review
 * invoice aging buckets (<48h / <7d / overdue), disputed totals, the
 * dunning work queue with `past_due_since`, and the Stripe webhook
 * health panel.
 *
 * BILL-03 adds the single mutating action on this page: "Retry charge"
 * per failed invoice (two-click confirm). Everything else stays read-only.
 * Status badges always pair a text label with color, never color alone.
 *
 * noindex,nofollow via the robots guard on the parent admin route; excluded
 * from prerendering like all admin pages.
 */
@Component({
  selector: 'app-admin-billing',
  standalone: true,
  imports: [DatePipe],
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

  /** Invoice awaiting the second (confirm) click of the retry flow. */
  private confirmRetryId: string | null = null;

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
    return model === 'commission' ? 'Commission · 1%' : 'Flat plan';
  }
}
