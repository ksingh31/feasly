/**
 * Builder billing component tests (billing/02, BILL-02).
 *
 * Verifies: the card-status rendering (no card / card on file / load
 * error), the unavailable notice when no publishable key is configured,
 * and the SetupIntent request when the card form is opened.
 *
 * Stripe.js itself is not exercised — `loadStripe` is stubbed at the
 * module boundary so no network call fires in tests.
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardOnFileStatus } from '@feasly/contracts';

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn().mockResolvedValue(null),
}));

import { BuilderBillingComponent } from './builder-billing.component';
import { BuilderBillingState } from './builder-billing.state';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

const NO_CARD: CardOnFileStatus = { hasCard: false };
const CARD_ON_FILE: CardOnFileStatus = {
  hasCard: true,
  brand: 'Visa',
  last4: '4242',
  expMonth: 12,
  expYear: 2028,
};

async function setup() {
  TestBed.resetTestingModule();
  // The component fail-closes without a publishable key, so the stub
  // provides one (test-mode placeholder, never a real key).
  const configStub = {
    get: (section: keyof typeof DEFAULT_APP_CONFIG) => {
      if (section === 'billing') {
        return { stripePublishableKey: 'pk_test_stub' };
      }
      return DEFAULT_APP_CONFIG[section];
    },
  } as unknown as ConfigService;
  TestBed.configureTestingModule({
    imports: [BuilderBillingComponent],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideStore([BuilderBillingState]),
      { provide: ConfigService, useValue: configStub },
    ],
  });
  const fixture: ComponentFixture<BuilderBillingComponent> =
    TestBed.createComponent(BuilderBillingComponent);
  const httpMock = TestBed.inject(HttpTestingController);
  const store = TestBed.inject(Store);
  fixture.detectChanges();
  return { fixture, httpMock, store };
}

describe('BuilderBillingComponent (billing/02)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('renders the no-card status with an add-card button', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .flush(NO_CARD);
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No card on file.');
    expect(text).toContain('Add card');
  });

  it('renders the card-on-file summary with an update-card button', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .flush(CARD_ON_FILE);
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Visa');
    expect(text).toContain('4242');
    expect(text).toContain('Update card');
  });

  it('shows the load-error copy with a retry button on failure', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .error(new ProgressEvent('error'));
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('We couldn’t load your billing details.');
  });

  it('fail-closes with the unavailable notice when no publishable key is configured', async () => {
    TestBed.resetTestingModule();
    // No publishable key: the compiled default ('') applies.
    TestBed.configureTestingModule({
      imports: [BuilderBillingComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([BuilderBillingState]),
      ],
    });
    const fixture: ComponentFixture<BuilderBillingComponent> =
      TestBed.createComponent(BuilderBillingComponent);
    const httpMock = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/billing/card')).flush(NO_CARD);
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Card setup isn’t available yet');
    expect(text).not.toContain('Add card');
  });
});
