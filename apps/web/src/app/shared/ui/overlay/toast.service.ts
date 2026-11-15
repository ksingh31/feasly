import { Overlay, type OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type Observable, Subject, type Subscription, timer } from 'rxjs';
import { ConfigService } from '@app/core/config';
import { UiToastHostComponent } from './toast-host.component';

/** Status tones (portal-ui-kit §1 `--status-*`). */
export type UiToastTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';
export type UiToastDismissReason = 'timeout' | 'undo' | 'close' | 'manual';

export interface UiToastOptions {
  message: string;
  /** Default `success`. */
  tone?: UiToastTone;
  /** Shows an Undo button; called when it is pressed (the toast then closes). */
  undo?: () => void;
  undoLabel?: string;
  /** Auto-dismiss delay; defaults to `timings.toastDurationMs` (5s). */
  durationMs?: number;
}

/** A toast as rendered by the host. */
export interface UiToast {
  id: number;
  message: string;
  tone: UiToastTone;
  undoLabel: string | null;
}

export interface UiToastRef {
  readonly id: number;
  /** Emits the reason once when the toast closes, then completes. */
  readonly dismissed: Observable<UiToastDismissReason>;
  dismiss(): void;
}

interface ToastEntry {
  toast: UiToast;
  options: UiToastOptions;
  timer: Subscription | null;
  dismissed: Subject<UiToastDismissReason>;
}

/** Oldest toasts beyond this are dismissed so the stack never covers the page. */
const MAX_VISIBLE = 3;

let nextToastId = 0;

/**
 * Toast — portal-ui-kit §3. Bottom-right (bottom-centre on mobile),
 * auto-dismiss after 5s, optional Undo. Replaces inline success banners
 * and select + Apply for instant changes (§5: undo toast for non-money
 * changes).
 *
 *   this.toasts.show({ message: 'Lead marked Contacted', undo: () => this.revert() });
 *
 * The timer pauses while the pointer or keyboard focus is on the toast, so
 * nobody loses the Undo mid-reach. Rendered in a CDK overlay that exists
 * only while a toast is showing.
 */
@Injectable({ providedIn: 'root' })
export class UiToastService {
  private readonly overlay = inject(Overlay);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly entries = new Map<number, ToastEntry>();
  private readonly _toasts = signal<readonly UiToast[]>([]);
  /** Visible toasts, oldest first. */
  readonly toasts = this._toasts.asReadonly();

  private overlayRef: OverlayRef | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      for (const entry of this.entries.values()) entry.timer?.unsubscribe();
      this.entries.clear();
      this.overlayRef?.dispose();
    });
  }

  show(options: UiToastOptions): UiToastRef {
    const id = nextToastId++;
    const toast: UiToast = {
      id,
      message: options.message,
      tone: options.tone ?? 'success',
      undoLabel: options.undo ? (options.undoLabel ?? 'Undo') : null,
    };
    const dismissed = new Subject<UiToastDismissReason>();
    this.entries.set(id, { toast, options, timer: null, dismissed });

    // Live region first, content second: screen readers announce text
    // inserted into an existing role="status" region more reliably.
    this.ensureHost();
    this._toasts.update((list) => [...list, toast]);
    this.startTimer(id);

    const overflow = this._toasts().length - MAX_VISIBLE;
    for (const old of this._toasts().slice(0, Math.max(0, overflow))) this.dismiss(old.id, 'manual');

    return {
      id,
      dismissed: dismissed.asObservable(),
      dismiss: () => this.dismiss(id, 'manual'),
    };
  }

  /** Undo pressed: run the callback, then close. */
  undo(id: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.options.undo?.();
    this.dismiss(id, 'undo');
  }

  dismiss(id: number, reason: UiToastDismissReason = 'manual'): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.timer?.unsubscribe();
    this.entries.delete(id);
    this._toasts.update((list) => list.filter((t) => t.id !== id));
    entry.dismissed.next(reason);
    entry.dismissed.complete();
    if (this.entries.size === 0) {
      this.overlayRef?.dispose();
      this.overlayRef = null;
    }
  }

  /** Pointer / focus on the toast: hold the auto-dismiss. */
  pause(id: number): void {
    const entry = this.entries.get(id);
    entry?.timer?.unsubscribe();
    if (entry) entry.timer = null;
  }

  /** Pointer / focus left: restart the full delay. */
  resume(id: number): void {
    const entry = this.entries.get(id);
    if (entry && !entry.timer) this.startTimer(id);
  }

  private startTimer(id: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const delay = entry.options.durationMs ?? this.config.get('timings').toastDurationMs;
    entry.timer = timer(delay)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.dismiss(id, 'timeout'));
  }

  private ensureHost(): void {
    if (this.overlayRef) return;
    this.overlayRef = this.overlay.create({
      positionStrategy: this.overlay.position().global().bottom('0').right('0'),
      scrollStrategy: this.overlay.scrollStrategies.noop(),
      hasBackdrop: false,
      panelClass: 'ui-toast-pane',
    });
    const host = this.overlayRef.attach(new ComponentPortal(UiToastHostComponent));
    host.changeDetectorRef.detectChanges();
  }
}
