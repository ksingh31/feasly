import { Injectable, signal } from '@angular/core';

/**
 * Session-only UI state for the dashboard due-invoice banners.
 *
 * Provided in root so banner state survives in-page navigation (dashboard
 * ↔ invoices), but everything lives in memory: a refresh wipes it and the
 * banners come back. There is deliberately NO persistence (no
 * storage-plugin, no localStorage) and NO backend call — dismissing a
 * banner never touches invoice state. A banner disappears for good only
 * when its invoice leaves the due set (e.g. staff marks it paid), which
 * is purely data-driven.
 */
@Injectable({ providedIn: 'root' })
export class DueInvoiceBannersService {
  private readonly dismissedIds = signal<ReadonlySet<string>>(new Set());
  private readonly openIds = signal<ReadonlySet<string>>(new Set());
  private readonly collapsed = signal(false);

  /** Invoice ids dismissed for this UI session. */
  readonly dismissed = this.dismissedIds.asReadonly();
  /** Invoice ids whose banner is expanded. */
  readonly open = this.openIds.asReadonly();
  /** Whether the whole stack is folded into the slim summary bar. */
  readonly stackCollapsed = this.collapsed.asReadonly();

  isDismissed(id: string): boolean {
    return this.dismissedIds().has(id);
  }

  isOpen(id: string): boolean {
    return this.openIds().has(id);
  }

  /** Dismiss one banner for this session only (no backend change). */
  dismiss(id: string): void {
    this.dismissedIds.update((ids) => new Set(ids).add(id));
    this.openIds.update((ids) => {
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
  }

  /** Dismiss every currently visible banner for this session only. */
  dismissAll(ids: readonly string[]): void {
    this.dismissedIds.update((prev) => new Set([...prev, ...ids]));
    this.openIds.update((ids) => {
      const next = new Set(ids);
      for (const id of ids) {
        next.delete(id);
      }
      return next;
    });
  }

  toggleOpen(id: string): void {
    this.openIds.update((ids) => {
      const next = new Set(ids);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  setStackCollapsed(collapsed: boolean): void {
    this.collapsed.set(collapsed);
  }
}
