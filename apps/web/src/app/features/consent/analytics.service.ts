import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import type { AnalyticsEvent, AnalyticsEventName, AnalyticsSource } from '@feasly/contracts';
import { firstValueFrom } from 'rxjs';
import { API_SERVICE } from '../../core/api/api.service';
import { selectCampaignSource } from './campaign-source.state';
import { ConsentStateName, type ConsentStateModel } from './consent.state';

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
    const { status, consentTs } = this.consent();
    if (status !== 'granted' || consentTs == null) return;
    // #815: the session's campaign attribution rides on every event.
    const source = this.store.selectSnapshot(selectCampaignSource);
    const payload: AnalyticsEvent = {
      event,
      route: route ?? this.router.url.split('?')[0],
      ts: new Date().toISOString(),
      consent_ts: consentTs,
      ...(source ? { source } : {}),
    };
    // No subscription: `firstValueFrom` settles the single emission, and the
    // caught rejection keeps this fire-and-forget.
    void firstValueFrom(this.api.trackEvent(payload)).catch(() => undefined);
  }

  /**
   * #815: campaign attribution for the lead submit. Behind the same
   * analytics opt-in as events (#814 decision Q2): undefined unless consent
   * was granted and the session carried a source.
   */
  leadSource(): AnalyticsSource | undefined {
    if (this.consent().status !== 'granted') return undefined;
    return this.store.selectSnapshot(selectCampaignSource) ?? undefined;
  }

  /**
   * Consent snapshot read from the root state. Missing state (a page spec
   * that never registered ConsentState) reads as pending, so call sites can
   * track freely and nothing fires.
   */
  private consent(): Partial<ConsentStateModel> {
    return (
      this.store.selectSnapshot(
        (root: { readonly [ConsentStateName]?: ConsentStateModel }) => root[ConsentStateName],
      ) ?? {}
    );
  }
}
