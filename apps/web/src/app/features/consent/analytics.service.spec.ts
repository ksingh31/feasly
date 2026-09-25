import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { of, throwError, type Observable } from 'rxjs';
import type { AnalyticsEvent } from '@feasly/contracts';
import { API_SERVICE, type ApiService } from '../../core/api/api.service';
import { AnalyticsService } from './analytics.service';
import { AcknowledgeConsent } from './consent.actions';
import { ConsentState } from './consent.state';

/**
 * Story consumer/01: the consent gate on analytics emission.
 * - pending/declined → track() is a silent no-op (network assertion: the
 *   API service is never called).
 * - granted → one POST-shaped call carrying the banner's consent_ts.
 * - backend failures never propagate to the caller.
 */
describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let store: Store;
  let trackEvent: Mock<(event: AnalyticsEvent) => Observable<undefined>>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    trackEvent = vi.fn((_event: AnalyticsEvent) => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideStore([ConsentState]),
        { provide: API_SERVICE, useValue: { trackEvent } satisfies Partial<ApiService> },
      ],
    });
    service = TestBed.inject(AnalyticsService);
    store = TestBed.inject(Store);
  });

  it('fires nothing before consent (pending)', () => {
    service.track('step_view');
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('fires nothing after decline (AC1 network assertion)', () => {
    store.dispatch(new AcknowledgeConsent(false));
    service.track('step_view');
    service.track('gate_convert');
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('emits the event with consent_ts after accept (AC1)', () => {
    store.dispatch(new AcknowledgeConsent(true));
    const consentTs = store.selectSnapshot(ConsentState.consentTs)!;
    service.track('gate_convert', '/estimate/gate');
    expect(trackEvent).toHaveBeenCalledTimes(1);
    const payload = trackEvent.mock.calls[0][0] as AnalyticsEvent;
    expect(payload.event).toBe('gate_convert');
    expect(payload.route).toBe('/estimate/gate');
    expect(payload.consent_ts).toBe(consentTs);
    expect(payload.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('defaults the route to the current router URL', () => {
    store.dispatch(new AcknowledgeConsent(true));
    service.track('step_view');
    const payload = trackEvent.mock.calls[0][0] as AnalyticsEvent;
    expect(payload.route).toBe('/');
  });

  it('swallows backend failures — analytics never breaks the app', () => {
    trackEvent.mockReturnValue(throwError(() => new Error('boom')));
    store.dispatch(new AcknowledgeConsent(true));
    expect(() => service.track('step_view')).not.toThrow();
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });
});
