import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import type { AnalyticsEvent, AnalyticsEventName } from '@feasly/contracts';
import { firstValueFrom } from 'rxjs';
import { API_SERVICE } from '../../core/api/api.service';
import { ConsentState } from './consent.state';

/**
 * First-party analytics emission (story consumer/01).
 *
 * The consent gate: `track()` is a silent no-op unless the consent banner
 * was acknowledged with "accept" — declining (or never answering) means
 * zero events fire, verified by the spec's network assertion. Every emitted
 * event carries the banner's `consent_ts`, which the backend requires.
 *
 * Only the allowlisted `AnalyticsEventName` contract values can be emitted
 * (the type system enforces it). Fire-and-forget: failures never surface
 * to the caller — analytics must never break the product. `firstValueFrom`
 * awaits the single emission with no subscription to manage (nothing
 * leaks), and the swallowed rejection keeps fire-and-forget semantics.
 */
@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  private readonly api = inject(API_SERVICE);
  private readonly store = inject(Store);
  private readonly router = inject(Router);

  track(event: AnalyticsEventName, route?: string): void {
    const status = this.store.selectSnapshot(ConsentState.status);
    const consentTs = this.store.selectSnapshot(ConsentState.consentTs);
    if (status !== 'granted' || consentTs == null) return;
    const payload: AnalyticsEvent = {
      event,
      route: route ?? this.router.url.split('?')[0],
      ts: new Date().toISOString(),
      consent_ts: consentTs,
    };
    // No subscription: `firstValueFrom` settles the single emission, and the
    // caught rejection keeps this fire-and-forget.
    void firstValueFrom(this.api.trackEvent(payload)).catch(() => undefined);
  }
}
