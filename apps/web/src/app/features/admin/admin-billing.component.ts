import { DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import { LoadBillingHealth } from './billing-health.actions';
import { BillingHealthState } from './billing-health.state';
import { formatCentsToCad } from '../../shared/utils/money';

/**
 * Billing-health dashboard (billing/03 follow-on — `/admin/billing`,
 * was OPS-007).
 *
 * Karan's read-only money overview: MRR (from Stripe subscription data
 * under the flat model), commission collected in the trailing 30 days,
 * in-review invoice aging buckets (<48h / <7d / overdue), disputed totals,
 * the dunning work queue with `past_due_since`, and the Stripe webhook
 * health panel.
 *
 * READ-ONLY by design — no charge/refund/void actions exist on this page
 * (or on the backing endpoint). Status badges always pair a text label
 * with color, never color alone.
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
