import { Dialog, type DialogRef } from '@angular/cdk/dialog';
import { hasModifierKey } from '@angular/cdk/keycodes';
import { Overlay } from '@angular/cdk/overlay';
import type { ComponentType } from '@angular/cdk/portal';
import { Location } from '@angular/common';
import { type Injector, Injectable, type Signal, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { type Observable, ReplaySubject, filter, map, of, shareReplay, take, takeUntil } from 'rxjs';
import type { UiConfirmOptions } from './confirm-dialog.component';
import { UiConfirmService } from './confirm.service';

export type UiDrawerSize = 'sm' | 'md' | 'lg';

/** The query param that carries the open record (portal-ui-kit §3: `?open=<id>`). */
export const UI_DRAWER_URL_PARAM = 'open';

/** Copy for the "unsaved changes" question. Every field is overridable per drawer. */
export const UI_DRAWER_DISCARD_DEFAULTS: UiConfirmOptions = {
  title: 'Discard your changes?',
  body: "Your edits here aren't saved yet.",
  verb: 'Discard',
  cancelLabel: 'Keep editing',
  tone: 'danger',
};

export interface UiDrawerOptions<D = unknown> {
  /** Injected into the content component as `DIALOG_DATA`. */
  data?: D;
  /** `sm` 400 · `md` 480/560 (default) · `lg` 640/720. Full-height sheet below 768px. */
  size?: UiDrawerSize;
  /**
   * Record id to mirror in the URL as `?open=<id>`. Opening pushes a history
   * entry, so the browser Back button closes the drawer; a deep link that
   * already carries the id opens without a new entry.
   */
  urlId?: string;
  /** Overrides for the dirty-guard question. */
  discardConfirm?: Partial<UiConfirmOptions>;
  /** Parent injector for the content (defaults to the root injector). */
  injector?: Injector;
}

type CloseVia = 'ui' | 'nav' | 'replace';

/**
 * Handle for one open drawer. Injected into the content component (and the
 * `ui-drawer` shell) as `UiDrawerRef`.
 */
export class UiDrawerRef<R = unknown, C = unknown> {
  /** `true` while the content reports unsaved changes (`<ui-drawer [dirty]>`). */
  readonly dirty = signal(false);
  /** Emits the result once when the drawer is gone (`undefined` if dismissed), then completes. */
  readonly closed: Observable<R | undefined>;

  /** @internal Typed loosely so refs of any result type share the service's bookkeeping. */
  dialogRef: DialogRef<unknown, unknown> | null = null;
  /** @internal */ finished = false;
  /** @internal */ pushed = false;
  /** @internal */ lastUrl: string | null = null;
  /** @internal */ confirming: Observable<boolean> | null = null;
  /** @internal */ readonly closedSubject = new ReplaySubject<unknown>(1);

  constructor(
    private readonly service: UiDrawerService,
    readonly titleId: string,
    readonly urlId: string | null,
    /** @internal */ readonly discard: UiConfirmOptions,
  ) {
    this.closed = this.closedSubject.asObservable() as Observable<R | undefined>;
  }

  get componentInstance(): C | null {
    return (this.dialogRef?.componentInstance as C | undefined) ?? null;
  }

  setDirty(dirty: boolean): void {
    this.dirty.set(dirty);
  }

  /** Close now, skipping the dirty guard (e.g. after a successful save). */
  close(result?: R): void {
    this.service.finish(this, 'ui', result);
  }

  /**
   * Close like the user asked to (×, Esc, scrim, Cancel): asks first when
   * there are unsaved changes. Emits `true` if the drawer closed.
   */
  requestClose(): Observable<boolean> {
    return this.service.requestClose(this, 'ui');
  }
}

let nextDrawerId = 0;

/**
 * Drawer service — portal-ui-kit §3. A right-side panel on the CDK Dialog
 * (scrim, scroll lock, focus trap). Focus goes to the title on open and
 * back to the trigger on close. One drawer at a time — opening another
 * replaces it (asking first if the current one is dirty); a modal may
 * stack on top.
 *
 *   readonly open = injectDrawerParam();
 *   constructor() {
 *     // Deep links and Back/Forward drive the drawer off the URL.
 *     effect(() => {
 *       const id = this.open();
 *       if (id) untracked(() => this.drawers.open(LeadDrawerComponent, { data: { id }, urlId: id }));
 *     });
 *   }
 *
 * The content renders its chrome with `<ui-drawer heading="…" [dirty]="form.dirty">`.
 * Esc, the scrim, × and Back all go through the dirty guard; `ref.close()`
 * skips it (use after a save).
 */
@Injectable({ providedIn: 'root' })
export class UiDrawerService {
  private readonly dialog = inject(Dialog);
  private readonly overlay = inject(Overlay);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly confirms = inject(UiConfirmService);

  private active: UiDrawerRef<unknown, unknown> | null = null;

  /** The drawer currently open (or being replaced), if any. */
  get openDrawer(): UiDrawerRef | null {
    return this.active;
  }

  open<C, R = unknown, D = unknown>(component: ComponentType<C>, options: UiDrawerOptions<D> = {}): UiDrawerRef<R, C> {
    const current = this.active;
    if (current && !current.finished && options.urlId && current.urlId === options.urlId) {
      return current as UiDrawerRef<R, C>;
    }

    const ref = new UiDrawerRef<R, C>(this, `ui-drawer-title-${nextDrawerId++}`, options.urlId ?? null, {
      ...UI_DRAWER_DISCARD_DEFAULTS,
      ...options.discardConfirm,
    });

    if (!current || current.finished) {
      this.attach(ref, component, options, null);
      return ref;
    }

    this.active = ref as UiDrawerRef;
    this.requestClose(current, 'replace').subscribe((ok) => {
      if (ok && this.active === (ref as UiDrawerRef)) {
        this.attach(ref, component, options, current);
      } else {
        if (this.active === (ref as UiDrawerRef)) this.active = current;
        ref.finished = true;
        ref.closedSubject.next(undefined);
        ref.closedSubject.complete();
      }
    });
    return ref;
  }

  /** @internal Guarded close: asks first when the drawer is dirty. */
  requestClose(ref: UiDrawerRef<unknown, unknown>, via: CloseVia): Observable<boolean> {
    if (ref.finished) return of(true);
    if (ref.confirming) return ref.confirming;
    if (!ref.dirty()) {
      this.finish(ref, via);
      return of(true);
    }
    const decision = this.confirms.confirm(ref.discard).pipe(take(1), shareReplay(1));
    ref.confirming = decision;
    decision.subscribe((ok) => {
      ref.confirming = null;
      if (ok) this.finish(ref, via);
      else if (via === 'nav') this.restoreUrl(ref);
    });
    return decision;
  }

  /** @internal Close now; `ui` closes also drop `?open=` from the URL. */
  finish(ref: UiDrawerRef<unknown, unknown>, via: CloseVia, result?: unknown): void {
    if (ref.finished) return;
    ref.finished = true;
    if (via === 'ui') this.clearUrl(ref);
    if (ref.dialogRef) {
      ref.dialogRef.close(result);
    } else {
      ref.closedSubject.next(undefined);
      ref.closedSubject.complete();
    }
  }

  private attach<C, R, D>(
    ref: UiDrawerRef<R, C>,
    component: ComponentType<C>,
    options: UiDrawerOptions<D>,
    previous: UiDrawerRef<unknown, unknown> | null,
  ): void {
    this.active = ref as UiDrawerRef;
    if (ref.urlId) this.syncUrl(ref, previous);

    const dialogRef = this.dialog.open<R, D, C>(component, {
      data: options.data,
      role: 'dialog',
      ariaModal: true,
      ariaLabelledBy: ref.titleId,
      autoFocus: '.ui-drawer__title',
      restoreFocus: true,
      // Every close path goes through the dirty guard below; Back is handled
      // by the router listener, not the CDK's blind close-on-popstate.
      disableClose: true,
      closeOnNavigation: false,
      positionStrategy: this.overlay.position().global().top('0').right('0'),
      // Widths and the full height come from the size classes (drawer.component.scss);
      // drop the CDK's inline 80vw cap so they apply.
      maxWidth: 'none',
      panelClass: ['ui-drawer-pane', `ui-drawer-pane--${options.size ?? 'md'}`],
      backdropClass: 'ui-drawer-scrim',
      injector: options.injector,
      providers: [{ provide: UiDrawerRef, useValue: ref }],
    });
    ref.dialogRef = dialogRef as DialogRef<unknown, unknown>;

    dialogRef.closed.pipe(take(1)).subscribe((result) => {
      ref.finished = true;
      if (this.active === (ref as UiDrawerRef)) this.active = null;
      ref.closedSubject.next(result);
      ref.closedSubject.complete();
    });

    dialogRef.keydownEvents
      .pipe(
        filter((event) => event.key === 'Escape' && !hasModifierKey(event)),
        takeUntil(dialogRef.closed),
      )
      .subscribe((event) => {
        event.preventDefault();
        this.requestClose(ref, 'ui');
      });
    dialogRef.backdropClick.pipe(takeUntil(dialogRef.closed)).subscribe(() => this.requestClose(ref, 'ui'));

    if (ref.urlId) {
      this.router.events
        .pipe(
          filter((event): event is NavigationEnd => event instanceof NavigationEnd),
          takeUntil(dialogRef.closed),
        )
        .subscribe(() => {
          if (ref.finished) return;
          if (this.currentParam() === ref.urlId) ref.lastUrl = this.router.url;
          else this.requestClose(ref, 'nav');
        });
    }
  }

  /** Put `?open=<id>` in the URL — a new history entry, so Back closes the drawer. */
  private syncUrl(ref: UiDrawerRef<unknown, unknown>, previous: UiDrawerRef<unknown, unknown> | null): void {
    const param = this.currentParam();
    if (param === ref.urlId) {
      // Deep link (or Back/Forward already moved the URL): no new entry.
      ref.pushed = false;
      ref.lastUrl = this.router.url;
    } else if (previous?.urlId && param === previous.urlId) {
      // Swapping records: reuse the previous drawer's history entry.
      ref.pushed = previous.pushed;
      this.navigateParam(ref.urlId, true);
    } else {
      ref.pushed = true;
      this.navigateParam(ref.urlId, false);
    }
  }

  /** A UI close: undo our history entry if we pushed one, else strip the param in place. */
  private clearUrl(ref: UiDrawerRef<unknown, unknown>): void {
    if (!ref.urlId || this.currentParam() !== ref.urlId) return;
    if (ref.pushed) this.location.back();
    else this.navigateParam(null, true);
  }

  /** Back was pressed on a dirty drawer and the user kept editing: put the URL back. */
  private restoreUrl(ref: UiDrawerRef<unknown, unknown>): void {
    ref.pushed = true;
    if (ref.lastUrl) void this.router.navigateByUrl(ref.lastUrl);
    else this.navigateParam(ref.urlId, false);
  }

  private navigateParam(value: string | null, replaceUrl: boolean): void {
    void this.router.navigate([], {
      queryParams: { [UI_DRAWER_URL_PARAM]: value },
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }

  private currentParam(): string | null {
    return readDrawerParam(this.router);
  }
}

function readDrawerParam(router: Router): string | null {
  const value = router.parseUrl(router.url).queryParams[UI_DRAWER_URL_PARAM];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The `?open=<id>` value as a signal. Call in an injection context (field
 * initialiser) of the page that hosts the drawer, and open the drawer off
 * it so deep links and Back/Forward work.
 */
export function injectDrawerParam(): Signal<string | null> {
  const router = inject(Router);
  return toSignal(
    router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => readDrawerParam(router)),
    ),
    { initialValue: readDrawerParam(router) },
  );
}
