import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Store } from '@ngxs/store';
import type {
  BillingHealthAwaitingSettlementInvoice,
  BillingHealthUnprocessedEvent,
} from '@feasly/contracts';
import {
  type DataTableColumn,
  DataTableComponent,
  ErrorStateComponent,
  KitCountPipe,
  KitDateTimePipe,
  KitRelativePipe,
  KpiGridComponent,
  KpiTileComponent,
  PageHeaderComponent,
  SkeletonComponent,
  StatusChipComponent,
  UiButtonComponent,
  UiCellDirective,
} from '../../shared/ui';
import { LoadBillingHealth } from './billing-health.actions';
import { BillingHealthState } from './billing-health.state';

/** One row of the trailing-24h event-type breakdown. */
interface WebhookTypeRow {
  readonly type: string;
  readonly count: number;
}

/**
 * Admin Webhooks (#547) — `/admin/webhooks`.
 *
 * Stripe webhook health, split out of the Billing overview per the admin
 * page map (docs/reviews/2026-11-13-admin.md): a health chip, KPI tiles
 * (received / unhandled / model mismatches, trailing 24h), an
 * unhandled-types alert, and the event-type DataTable. Read-only.
 *
 * #711: also lists events received but not processed (the handler threw
 * and no redelivery has succeeded) and commission invoices awaiting
 * settlement past the threshold — each with an empty state when clear.
 *
 * Data comes from the existing billing-health payload
 * (`GET /api/v1/admin/billing` → `webhooks`) via BillingHealthState — no
 * new endpoint. Dates go through the kit pipes.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-admin-webhooks',
  standalone: true,
  imports: [
    PageHeaderComponent,
    StatusChipComponent,
    UiButtonComponent,
    KpiGridComponent,
    KpiTileComponent,
    DataTableComponent,
    UiCellDirective,
    ErrorStateComponent,
    SkeletonComponent,
    KitCountPipe,
    KitDateTimePipe,
    KitRelativePipe,
  ],
  templateUrl: './admin-webhooks.component.html',
  styleUrl: './admin-webhooks.component.scss',
})
export class AdminWebhooksComponent implements OnInit {
  private readonly store = inject(Store);

  protected readonly health = this.store.selectSignal(BillingHealthState.health);
  protected readonly loadStatus = this.store.selectSignal(BillingHealthState.loadStatus);
  protected readonly error = this.store.selectSignal(BillingHealthState.error);

  /** Reference instant for "Last received … ago"; advances on refresh. */
  protected readonly now = signal(new Date());

  protected readonly webhooks = computed(() => this.health()?.webhooks ?? null);

  /** #711: recorded-but-unprocessed events (oldest first, from the API). */
  protected readonly unprocessedRows = computed<readonly BillingHealthUnprocessedEvent[]>(
    () => this.webhooks()?.unprocessed ?? [],
  );

  /** #711: invoices finalized past the settlement threshold. */
  protected readonly awaitingRows = computed<readonly BillingHealthAwaitingSettlementInvoice[]>(
    () => this.webhooks()?.awaitingSettlement ?? [],
  );

  /**
   * Header chip: problem on model mismatches or unprocessed events (money
   * may have moved without the invoice changing); attention on unhandled
   * types or invoices awaiting settlement.
   */
  protected readonly flag = computed(() => {
    const w = this.webhooks();
    if (!w) return null;
    if (w.modelMismatch24h > 0 || this.unprocessedRows().length > 0) return 'problem';
    return w.unhandled24h > 0 || this.awaitingRows().length > 0 ? 'attention' : 'ok';
  });

  /** Busiest event types first. */
  protected readonly typeRows = computed<readonly WebhookTypeRow[]>(() =>
    [...(this.webhooks()?.byType24h ?? [])].sort(
      (a, b) => b.count - a.count || a.type.localeCompare(b.type),
    ),
  );

  protected readonly columns: readonly DataTableColumn<WebhookTypeRow>[] = [
    { key: 'type', header: 'Event type', kind: 'id', cardRole: 'title' },
    { key: 'count', header: 'Events (24h)', kind: 'count' },
  ];
  protected readonly rowId = (row: WebhookTypeRow): string => row.type;

  protected readonly unprocessedColumns: readonly DataTableColumn<BillingHealthUnprocessedEvent>[] = [
    { key: 'eventId', header: 'Event', kind: 'id', cardRole: 'title' },
    { key: 'type', header: 'Event type', kind: 'id', cardRole: 'meta' },
    { key: 'receivedAt', header: 'Received', kind: 'date', cardRole: 'meta' },
  ];
  protected readonly unprocessedId = (row: BillingHealthUnprocessedEvent): string => row.eventId;

  protected readonly awaitingColumns: readonly DataTableColumn<BillingHealthAwaitingSettlementInvoice>[] = [
    { key: 'tenantKey', header: 'Builder', kind: 'id', cardRole: 'title' },
    { key: 'commissionCents', header: 'Amount', kind: 'money', cardRole: 'meta' },
    { key: 'awaitingSince', header: 'Charge started', kind: 'date', cardRole: 'meta' },
  ];
  protected readonly awaitingId = (row: BillingHealthAwaitingSettlementInvoice): string => row.id;

  ngOnInit(): void {
    this.refresh();
  }

  protected refresh(): void {
    this.now.set(new Date());
    this.store.dispatch(new LoadBillingHealth());
  }
}
