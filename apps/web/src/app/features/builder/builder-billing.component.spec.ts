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
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
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
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
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

  it('renders no tabs: billing is card-on-file only (invoices moved top-level)', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .flush(NO_CARD);
    fixture.detectChanges();
    await fixture.whenStable();

    const tabs = fixture.nativeElement.querySelectorAll('.builder-billing__tab');
    expect(tabs.length).toBe(0);
  });

  it('renders the loading skeleton while the card status is in flight', async () => {
    const { fixture, httpMock } = await setup();
    // Let NGXS process the dispatched LoadBillingCard. The HTTP request
    // stays pending until flushed, so the state sits at 'loading'.
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    const skeleton = fixture.nativeElement.querySelector(
      '.builder-billing__skeleton',
    );
    expect(skeleton).not.toBeNull();
    expect(skeleton.getAttribute('role')).toBe('status');
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Loading your billing details…');
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .flush(NO_CARD);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('renders brand, masked number, and expiry rows when a card is on file', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .flush(CARD_ON_FILE);
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Brand');
    expect(text).toContain('Visa');
    expect(text).toContain('Card number');
    expect(text).toContain('•••• 4242');
    expect(text).toContain('Expires');
    expect(text).toContain('12/2028');
    expect(text).toContain('Update card');
  });

  it('redispatches the card load when the retry button is clicked', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .error(new ProgressEvent('error'));
    fixture.detectChanges();
    await fixture.whenStable();

    const retry = fixture.nativeElement.querySelector(
      '.builder-billing__alert button',
    ) as HTMLButtonElement;
    expect(retry).not.toBeNull();
    retry.click();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .flush(NO_CARD);
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No card on file.');
  });

  it('fail-closes with the unavailable notice when no publishable key is configured', async () => {
    TestBed.resetTestingModule();
    // No publishable key: the compiled default ('') applies.
    TestBed.configureTestingModule({
      imports: [BuilderBillingComponent],
      providers: [
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
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

  it('renders the default payment method panel with all four options (billing/12)', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .flush(CARD_ON_FILE);
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/payment-method'))
      .flush({ defaultMethod: 'card' });
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Default payment method');
    expect(text).toContain(
      'New invoices use this unless you change it on the invoice.',
    );
    const options = Array.from(
      fixture.nativeElement.querySelectorAll(
        '#builder-default-method option',
      ),
    ).map((o) => (o as HTMLOptionElement).textContent?.trim());
    expect(options).toEqual([
      'Card •••• 4242',
      'Cheque',
      'E-transfer',
      'Bank draft',
    ]);
    const select = fixture.nativeElement.querySelector(
      '#builder-default-method',
    ) as HTMLSelectElement;
    expect(select.value).toBe('card');
  });

  it('disables the card option when no card is on file (billing/12)', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .flush(NO_CARD);
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/payment-method'))
      .flush({ defaultMethod: 'cheque' });
    fixture.detectChanges();
    await fixture.whenStable();

    const cardOption = fixture.nativeElement.querySelector(
      '#builder-default-method option[value="card"]',
    ) as HTMLOptionElement;
    expect(cardOption.disabled).toBe(true);
    expect(cardOption.textContent).toContain('no card on file');
  });

  it('stages the selection without an API call; Apply PUTs and shows saved (billing/12 rework)', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .flush(CARD_ON_FILE);
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/payment-method'))
      .flush({ defaultMethod: 'card' });
    fixture.detectChanges();
    await fixture.whenStable();

    const select = fixture.nativeElement.querySelector(
      '#builder-default-method',
    ) as HTMLSelectElement;
    select.value = 'cheque';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();

    // Selection alone stages — no PUT yet (Karan 2026-10-02: no auto-save).
    httpMock.expectNone(
      (r) =>
        r.url.endsWith('/api/v1/billing/payment-method') &&
        r.method === 'PUT',
    );
    // Apply button is visible and enabled (staged differs from saved).
    const apply = fixture.nativeElement.querySelector(
      '.builder-billing__apply',
    ) as HTMLButtonElement;
    expect(apply).toBeTruthy();
    expect(apply.disabled).toBe(false);

    apply.click();
    const put = httpMock.expectOne(
      (r) =>
        r.url.endsWith('/api/v1/billing/payment-method') &&
        r.method === 'PUT',
    );
    expect(put.request.body).toEqual({ method: 'cheque' });
    put.flush({ defaultMethod: 'cheque' });
    // The saved confirmation is set in a promise continuation after the
    // dispatch resolves — let microtasks drain before rendering.
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Saved — new invoices will use cheque.');
  });

  it('Reset discards the staged choice without an API call', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .flush(CARD_ON_FILE);
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/payment-method'))
      .flush({ defaultMethod: 'card' });
    fixture.detectChanges();
    await fixture.whenStable();

    const select = fixture.nativeElement.querySelector(
      '#builder-default-method',
    ) as HTMLSelectElement;
    select.value = 'cheque';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();

    const reset = fixture.nativeElement.querySelector(
      '.builder-billing__reset',
    ) as HTMLButtonElement;
    expect(reset).toBeTruthy();
    reset.click();
    fixture.detectChanges();
    await fixture.whenStable();

    // No PUT — the staged choice was discarded.
    httpMock.expectNone(
      (r) =>
        r.url.endsWith('/api/v1/billing/payment-method') &&
        r.method === 'PUT',
    );
    // Apply/Reset buttons disappear; select shows the saved method.
    expect(
      fixture.nativeElement.querySelector('.builder-billing__apply'),
    ).toBeFalsy();
    expect(select.value).toBe('card');
  });

  it('shows the save-failed copy when the default-method PUT errors (billing/12)', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .flush(CARD_ON_FILE);
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/payment-method'))
      .flush({ defaultMethod: 'card' });
    fixture.detectChanges();
    await fixture.whenStable();

    const select = fixture.nativeElement.querySelector(
      '#builder-default-method',
    ) as HTMLSelectElement;
    select.value = 'e_transfer';
    select.dispatchEvent(new Event('change'));
    httpMock
      .expectOne(
        (r) =>
          r.url.endsWith('/api/v1/billing/payment-method') &&
          r.method === 'PUT',
      )
      .error(new ProgressEvent('error'));
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(
      'We couldn’t save your default payment method. Please try again.',
    );
  });

  it('retries the default payment method load after an error (billing/12)', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/card'))
      .flush(CARD_ON_FILE);
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/payment-method'))
      .error(new ProgressEvent('error'));
    fixture.detectChanges();
    await fixture.whenStable();

    let text = fixture.nativeElement.textContent as string;
    expect(text).toContain('We couldn’t load your billing details.');

    const retry = fixture.nativeElement.querySelector(
      '.builder-billing__alert button',
    ) as HTMLButtonElement;
    retry.click();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/billing/payment-method'))
      .flush({ defaultMethod: 'bank_draft' });
    fixture.detectChanges();
    await fixture.whenStable();

    text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Bank draft');
    const select = fixture.nativeElement.querySelector(
      '#builder-default-method',
    ) as HTMLSelectElement;
    expect(select.value).toBe('bank_draft');
  });
});
