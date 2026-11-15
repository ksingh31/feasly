import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import { interval, startWith } from 'rxjs';
import { InfoTooltipComponent } from '../../shared/components/info-tooltip';
import {
  ErrorStateComponent,
  KitCountPipe,
  KitDateTimePipe,
  KitRelativePipe,
  KpiGridComponent,
  KpiTileComponent,
  PageHeaderComponent,
  SkeletonComponent,
  StatusChipComponent,
  type StatusTone,
  type TimelineEvent,
  TimelineComponent,
  UiButtonComponent,
} from '../../shared/ui';
import {
  LoadSheetsSyncStatus,
  TriggerSheetsSyncNow,
} from './sheets-sync.actions';
import { SheetsSyncState } from './sheets-sync.state';

/** Failing threshold (admin/05 AC2) — mirrors `sheetsSyncBadgeFor`. */
const FAILING_AFTER = 3;

/**
 * Sheets sync ops panel (admin/05, kit migration #547) — `/admin/ops/sheets`.
 *
 * One glance at worker health: a health StatusChip in the page header
 * (Healthy / Lagging / Failing / Not started — always a text label, never
 * colour-only; the thresholds live in the ⓘ tooltip beside it), a
 * "Sync now" kit button that shows a running state while a run is in
 * flight, five KPI tiles, and the recent sanitized failures as a kit
 * Timeline. Dates go through the kit pipes (no seconds, no raw ISO).
 *
 * noindex,nofollow via the robots guard on the parent admin route; excluded
 * from prerendering like all admin pages.
 */
@Component({
  selector: 'app-admin-sheets-status',
  standalone: true,
  imports: [
    PageHeaderComponent,
    StatusChipComponent,
    InfoTooltipComponent,
    UiButtonComponent,
    KpiGridComponent,
    KpiTileComponent,
    TimelineComponent,
    ErrorStateComponent,
    SkeletonComponent,
    KitCountPipe,
    KitDateTimePipe,
    KitRelativePipe,
  ],
  templateUrl: './admin-sheets-status.component.html',
  styleUrl: './admin-sheets-status.component.scss',
})
export class AdminSheetsStatusComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly status = this.store.selectSignal(SheetsSyncState.status);
  protected readonly badge = this.store.selectSignal(SheetsSyncState.badge);
  protected readonly loadStatus = this.store.selectSignal(
    SheetsSyncState.loadStatus,
  );
  protected readonly triggering = this.store.selectSignal(
    SheetsSyncState.triggering,
  );
  protected readonly lastTrigger = this.store.selectSignal(
    SheetsSyncState.lastTrigger,
  );
  protected readonly error = this.store.selectSignal(SheetsSyncState.error);
  protected readonly syncNowDisabled = this.store.selectSignal(
    SheetsSyncState.syncNowDisabled,
  );

  /** Reference instant for relative times; advances with each refresh. */
  protected readonly now = signal(new Date());

  /**
   * Header health chip. A worker that has never run reads "Not started"
   * (neutral), not "Healthy" (review B18).
   */
  protected readonly health = computed(() => {
    const s = this.status();
    const badge = this.badge();
    if (!s || !badge) return null;
    if (!s.last_run_at && badge === 'healthy') return 'not_started';
    return badge;
  });

  /** True while the worker (or a manual trigger) is running. */
  protected readonly running = computed(
    () => this.triggering() || this.status()?.run_in_flight === true,
  );

  protected readonly failuresTone = computed<StatusTone | undefined>(() => {
    const n = this.status()?.consecutive_failures ?? 0;
    if (n >= FAILING_AFTER) return 'danger';
    return n > 0 ? 'warning' : undefined;
  });

  /** Recent failures as Timeline events (sanitized messages only). */
  protected readonly failureEvents = computed<readonly TimelineEvent[]>(() =>
    (this.status()?.recent_failures ?? []).map((f, i) => ({
      id: `failure-${i}`,
      at: f.at,
      title: f.error,
      tone: 'danger',
    })),
  );

  ngOnInit(): void {
    // Refresh the panel every 60s so a run that finishes in the background
    // (or is triggered from elsewhere) shows up without a manual reload.
    // startWith(0) fires the initial load — no separate dispatch needed.
    // The interval is torn down with the component — no orphaned timers.
    interval(60_000)
      .pipe(startWith(0), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.now.set(new Date());
        this.store.dispatch(new LoadSheetsSyncStatus());
      });
  }

  protected onSyncNow(): void {
    this.store.dispatch(new TriggerSheetsSyncNow());
  }

  protected retry(): void {
    this.store.dispatch(new LoadSheetsSyncStatus());
  }
}
