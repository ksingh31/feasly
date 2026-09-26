import { DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import { interval, startWith } from 'rxjs';
import {
  LoadSheetsSyncStatus,
  TriggerSheetsSyncNow,
} from './sheets-sync.actions';
import { SheetsSyncState } from './sheets-sync.state';

/**
 * Sheets sync ops panel (admin/05) — `/admin/ops/sheets`.
 *
 * One glance at worker health: status badge (Healthy / Lagging / Failing —
 * always with a text label, never color-only), last-run timestamps, rows
 * synced, pending count, a "Sync now" manual trigger (audit-logged
 * server-side), and the recent sanitized failure messages.
 *
 * Badge thresholds (also shown on the panel itself, admin/05 AC2):
 * Failing = 3+ consecutive failures · Lagging = no successful sync in the
 * last 2 hours · otherwise Healthy.
 *
 * noindex,nofollow via the robots guard on the parent admin route; excluded
 * from prerendering like all admin pages.
 */
@Component({
  selector: 'app-admin-sheets-status',
  standalone: true,
  imports: [DatePipe],
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

  ngOnInit(): void {
    // Refresh the panel every 60s so a run that finishes in the background
    // (or is triggered from elsewhere) shows up without a manual reload.
    // startWith(0) fires the initial load — no separate dispatch needed.
    // The interval is torn down with the component — no orphaned timers.
    interval(60_000)
      .pipe(startWith(0), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.store.dispatch(new LoadSheetsSyncStatus()));
  }

  protected onSyncNow(): void {
    this.store.dispatch(new TriggerSheetsSyncNow());
  }

  protected retry(): void {
    this.store.dispatch(new LoadSheetsSyncStatus());
  }
}
