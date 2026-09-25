import { Component, DestroyRef, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Title } from '@angular/platform-browser';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  SheetsSyncAdminService,
  type SheetsSyncHealth,
  type SheetsSyncStatus,
} from './sheets-sync-admin.service';

/**
 * Sheets sync status page (admin/05): `/admin/ops/sheets`.
 *
 * Shows the worker health badge (Healthy / Lagging / Failing / Disabled),
 * last-run summary, pending + total lead counts, a "Sync now" button
 * (disabled while a run is in flight), and the recent run history.
 *
 * Interim auth: prompts for the X-Admin-Key on first load (kept in
 * sessionStorage) until admin/01's session auth lands.
 */

/** HTTP 401 — the stored admin key is wrong; prompt again. */
const HTTP_UNAUTHORIZED = 401;
@Component({
  selector: 'app-sheets-status-page',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './sheets-status-page.component.html',
  styleUrl: './sheets-status-page.component.scss',
})
export class SheetsStatusPageComponent {
  private readonly admin = inject(SheetsSyncAdminService);
  private readonly title = inject(Title);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly status = signal<SheetsSyncStatus | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly syncing = signal(false);
  protected readonly needsKey = signal(false);
  protected readonly keyInput = signal('');

  constructor() {
    // Noindex is set by robotsGuard via route data; title set directly.
    this.title.setTitle('Sheets sync status — Feasly admin');
    if (!this.admin.getAdminKey()) {
      this.needsKey.set(true);
      this.loading.set(false);
    } else {
      this.refresh();
    }
  }

  protected submitKey(): void {
    const key = this.keyInput().trim();
    if (!key) return;
    this.admin.setAdminKey(key);
    this.needsKey.set(false);
    this.refresh();
  }

  protected refresh(): void {
    this.loading.set(true);
    this.error.set(null);
    this.admin
      .getStatus()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => {
          this.status.set(s);
          this.loading.set(false);
        },
        error: (e: unknown) => {
          const message = e instanceof Error ? e.message : 'Failed to load status.';
          // 401 → the key is wrong; prompt again.
          if (message.includes(String(HTTP_UNAUTHORIZED))) {
            this.admin.clearAdminKey();
            this.needsKey.set(true);
          } else {
            this.error.set(message);
          }
          this.loading.set(false);
        },
      });
  }

  protected syncNow(): void {
    const current = this.status();
    if (!current || current.runInFlight || this.syncing()) return;
    this.syncing.set(true);
    this.error.set(null);
    this.admin
      .triggerSyncNow()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.syncing.set(false);
          this.refresh();
        },
        error: (e: unknown) => {
          this.syncing.set(false);
          this.error.set(
            e instanceof Error ? e.message : 'Sync trigger failed.',
          );
        },
      });
  }

  protected badgeLabel(health: SheetsSyncHealth): string {
    switch (health) {
      case 'healthy':
        return 'Healthy';
      case 'lagging':
        return 'Lagging';
      case 'failing':
        return 'Failing';
      case 'disabled':
        return 'Disabled';
    }
  }

  protected onKeyInput(event: Event): void {
    this.keyInput.set((event.target as HTMLInputElement).value);
  }
}
