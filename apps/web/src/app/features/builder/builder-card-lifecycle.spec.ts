/**
 * #879 card lifecycle helpers + BuilderBillingState remove-card action.
 * Page-level behaviour (notices, confirm step, 409 copy) is covered in the
 * Billing and Money component specs.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BuilderBillingOverviewResponse, CardOnFileStatus } from '@feasly/contracts';
import { cardExpiry, cardLifecycleNotice } from './builder-card-lifecycle';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { LoadBillingOverview, RemoveBillingCard, ResetRemoveBillingCard } from './builder-billing.actions';
import { BuilderBillingState } from './builder-billing.state';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

const copy = DEFAULT_BUILDER_COPY.cardLifecycle;
const CARD: CardOnFileStatus = { hasCard: true, brand: 'visa', last4: '4242', expMonth: 3, expYear: 2027 };

describe('cardLifecycleNotice (#879)', () => {
  it('is null for no card, a missing card, or a healthy card', () => {
    expect(cardLifecycleNotice(null, copy)).toBeNull();
    expect(cardLifecycleNotice({ hasCard: false, expired: true }, copy)).toBeNull();
    expect(cardLifecycleNotice(CARD, copy)).toBeNull();
    expect(cardLifecycleNotice({ ...CARD, expiresSoon: false, expired: false }, copy)).toBeNull();
  });

  it('warns when the card expires soon, filling last4 and MM/YY', () => {
    expect(cardLifecycleNotice({ ...CARD, expiresSoon: true }, copy)).toEqual({
      kind: 'expiring',
      heading: copy.expiresSoonHeading,
      body: 'The card ending in 4242 expires 03/27. Replace it so upcoming charges go through.',
    });
  });

  it('expired wins over expires-soon', () => {
    const notice = cardLifecycleNotice({ ...CARD, expiresSoon: true, expired: true }, copy);
    expect(notice?.kind).toBe('expired');
    expect(notice?.heading).toBe(copy.expiredHeading);
    expect(notice?.body).toContain('expired 03/27');
  });

  it('falls back to a dash when last4/expiry are missing', () => {
    expect(cardLifecycleNotice({ hasCard: true, expired: true }, copy)?.body).toContain('ending in — expired —');
  });

  it('cardExpiry formats MM/YY', () => {
    expect(cardExpiry(CARD)).toBe('03/27');
    expect(cardExpiry({ hasCard: true })).toBeNull();
  });
});

describe('BuilderBillingState remove card (#879)', () => {
  let store: Store;
  let http: HttpTestingController;

  const OVERVIEW: BuilderBillingOverviewResponse = {
    planType: 'commission',
    commissionRatePercent: 1,
    currency: 'CAD',
    outstandingCents: 0,
    outstandingCount: 0,
    nextCharge: null,
    failedCount: 0,
    failedInvoices: [],
    disputedCount: 0,
    card: CARD,
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([BuilderBillingState]),
        { provide: ConfigService, useValue: { get: (k: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[k] } },
      ],
    });
    store = TestBed.inject(Store);
    http = TestBed.inject(HttpTestingController);
  });

  async function loadOverview(overview: BuilderBillingOverviewResponse) {
    const done = firstValueFrom(store.dispatch(new LoadBillingOverview()));
    http.expectOne((r) => r.url.endsWith('/api/v1/builder/billing/overview')).flush(overview);
    await done;
  }

  it('success writes { hasCard: false } to the card and the overview', async () => {
    await loadOverview(OVERVIEW);
    const done = firstValueFrom(store.dispatch(new RemoveBillingCard()));
    expect(store.selectSnapshot(BuilderBillingState.removeCardStatus)).toBe('removing');
    const req = http.expectOne((r) => r.url.endsWith('/api/v1/billing/card'));
    expect(req.request.method).toBe('DELETE');
    req.flush({ hasCard: false });
    await done;
    expect(store.selectSnapshot(BuilderBillingState.card)).toEqual({ hasCard: false });
    expect(store.selectSnapshot(BuilderBillingState.cardStatus)).toBe('ready');
    expect(store.selectSnapshot(BuilderBillingState.overview)?.card).toEqual({ hasCard: false });
    expect(store.selectSnapshot(BuilderBillingState.removeCardStatus)).toBe('idle');
  });

  it('keeps a flat-plan overview card as null', async () => {
    await loadOverview({ ...OVERVIEW, planType: 'flat', card: null });
    const done = firstValueFrom(store.dispatch(new RemoveBillingCard()));
    http.expectOne((r) => r.method === 'DELETE').flush({ hasCard: false });
    await done;
    expect(store.selectSnapshot(BuilderBillingState.overview)?.card).toBeNull();
  });

  it('409 keeps the API message; other failures leave it null; reset clears', async () => {
    let done = firstValueFrom(store.dispatch(new RemoveBillingCard()));
    http
      .expectOne((r) => r.method === 'DELETE')
      .flush(
        { code: 'CONFLICT', message: 'Invoice FEAS-1 is set to be charged to it.', retryable: false },
        { status: 409, statusText: 'Conflict' },
      );
    await done;
    expect(store.selectSnapshot(BuilderBillingState.removeCardStatus)).toBe('error');
    expect(store.selectSnapshot(BuilderBillingState.removeCardError)).toBe('Invoice FEAS-1 is set to be charged to it.');

    done = firstValueFrom(store.dispatch(new RemoveBillingCard()));
    http.expectOne((r) => r.method === 'DELETE').flush({}, { status: 403, statusText: 'Forbidden' });
    await done;
    expect(store.selectSnapshot(BuilderBillingState.removeCardStatus)).toBe('error');
    expect(store.selectSnapshot(BuilderBillingState.removeCardError)).toBeNull();

    store.dispatch(new ResetRemoveBillingCard());
    expect(store.selectSnapshot(BuilderBillingState.removeCardStatus)).toBe('idle');
  });
});
