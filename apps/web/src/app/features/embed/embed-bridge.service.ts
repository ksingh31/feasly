import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { Subject, debounceTime, filter } from 'rxjs';
import type {
  EmbedAuthOkMessage,
  EmbedEstimateStartMessage,
  EmbedIframeMessage,
  EmbedLeadCreatedMessage,
  EmbedReadyMessage,
  EmbedResizeMessage,
} from '@feasly/contracts';
import { EmbedState } from './embed.state';

/**
 * Debounce for resize posts: the story requires the iframe to settle within
 * 300 ms of a route/content change, so the debounce sits well under that.
 */
const RESIZE_DEBOUNCE_MS = 100;

/** Minimum sane height; the parent clamps to its own min/max as well. */
const MIN_HEIGHT_PX = 1;

/**
 * Iframe side of the embed postMessage bridge (embed/08).
 *
 * Outbound (iframe → parent): `feasly:ready`, `feasly:resize` (debounced),
 * `feasly:estimate-start`, `feasly:lead-created` (exactly once per lead),
 * `FEASLY_AUTH_OK`. No PII ever crosses the bridge — lead-created carries
 * only the opaque estimateId and the numeric leadScore.
 *
 * Outbound messages are never broadcast ('*'): the target is the embedding
 * page's origin when it appears in the tenant's `allowed_origins`,
 * otherwise our own origin for standalone visits. A '*' entry in
 * allowed_origins never authorizes anything.
 *
 * Inbound (parent → iframe): origin-gated against the tenant's
 * `allowed_origins`. Unknown origins are dropped and logged.
 *
 * No storage is used anywhere in this service — it works with third-party
 * cookies fully blocked (TECH_PLAN §2.2).
 */
@Injectable({ providedIn: 'root' })
export class EmbedBridgeService {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /** Resize requests funnel through here for debouncing. */
  private readonly resizeRequests = new Subject<number>();
  /** Lead IDs already announced — the bridge posts each lead exactly once. */
  private readonly announcedLeads = new Set<string>();
  private destroyed = false;

  constructor() {
    this.resizeRequests
      .pipe(debounceTime(RESIZE_DEBOUNCE_MS), takeUntilDestroyed(this.destroyRef))
      .subscribe((height) => this.post({ type: 'feasly:resize', height }));

    // Route transitions change content height: request a resize after each
    // navigation settles. The debounce keeps rapid transitions to one post.
    // Guarded: test doubles of Router may not provide the events observable.
    this.router.events
      ?.pipe(
        filter((ev) => ev instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.requestResize());

    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
  }

  /** The shell has booted: announce readiness to the parent. */
  notifyReady(): void {
    const msg: EmbedReadyMessage = { type: 'feasly:ready' };
    this.post(msg);
  }

  /**
   * Ask the parent to resize the iframe. Call on any content-size change;
   * posts are debounced so bursts collapse into one.
   */
  requestResize(height?: number): void {
    if (this.destroyed) return;
    const h = height ?? this.measureHeight();
    if (h >= MIN_HEIGHT_PX) {
      this.resizeRequests.next(Math.round(h));
    }
  }

  /** The user picked an address and started an estimate. */
  notifyEstimateStart(addressKey: string, address: string): void {
    const msg: EmbedEstimateStartMessage = {
      type: 'feasly:estimate-start',
      addressKey,
      address,
    };
    this.post(msg);
  }

  /**
   * A lead was created. Posts exactly once per leadId — repeat calls for
   * the same lead are silently ignored so the parent never double-counts
   * a conversion.
   */
  notifyLeadCreated(leadId: string, estimateId: string, leadScore?: number): void {
    if (this.announcedLeads.has(leadId)) return;
    this.announcedLeads.add(leadId);
    const msg: EmbedLeadCreatedMessage = { type: 'feasly:lead-created', estimateId };
    this.post(leadScore === undefined ? msg : { ...msg, leadScore });
  }

  /** The embed/06 relay handshake completed (reused, not rebuilt here). */
  notifyAuthOk(estimateId?: string): void {
    const msg: EmbedAuthOkMessage = { type: 'FEASLY_AUTH_OK' };
    this.post(estimateId === undefined ? msg : { ...msg, estimateId });
  }

  /**
   * Inbound gate for parent → iframe messages: the origin must appear in
   * the tenant's allowlist. Returns true when the message may be handled.
   * Unknown origins are dropped and logged by the caller.
   */
  isAllowedInbound(origin: string): boolean {
    const allowed = this.store.selectSnapshot(EmbedState.config)?.allowed_origins ?? [];
    return origin !== '' && origin !== '*' && allowed.includes(origin);
  }

  private measureHeight(): number {
    try {
      return document.documentElement?.offsetHeight ?? 0;
    } catch {
      return 0;
    }
  }

  private post(msg: EmbedIframeMessage): void {
    if (this.destroyed) return;
    try {
      if (typeof window === 'undefined' || window.parent === window) return;
      const target = this.parentTargetOrigin();
      if (target === undefined) return;
      window.parent.postMessage(msg, target);
    } catch {
      // postMessage can throw on detached windows — never break the app.
    }
  }

  private parentTargetOrigin(): string | undefined {
    try {
      const ref = document.referrer;
      if (ref !== '') {
        const origin = new URL(ref).origin;
        const allowed = this.store.selectSnapshot(EmbedState.config)?.allowed_origins ?? [];
        if (origin !== '*' && allowed.includes(origin)) return origin;
        return undefined;
      }
    } catch {
      return undefined;
    }
    return window.location.origin;
  }
}
