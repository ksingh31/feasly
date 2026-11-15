/**
 * Card modal (#534) tests.
 *
 * AC1 — the modal is the one card form, opened through `injectCardModal`
 * (Money, failed-card strip, invoice detail and Billing specs assert their
 * triggers call it). AC2 — no publishable key never renders the
 * contradictory "card setup isn't available" outage note; the modal explains
 * that a saved card keeps working. Plus: token-styled Stripe Element,
 * reassurance + charge-timing copy, save enabled only for a complete card,
 * success refresh/toast/close, decline and load-failure paths.
 *
 * Stripe.js is swapped via the STRIPE_LOADER token — no network.
 */
import { InteractivityChecker } from '@angular/cdk/a11y';
import { OverlayContainer } from '@angular/cdk/overlay';
import type { DialogRef } from '@angular/cdk/dialog';
import { TestBed } from '@angular/core/testing';
import { Store } from '@ngxs/store';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardOnFileStatus } from '@feasly/contracts';
import { UiToastService } from '@app/shared/ui';

import {
  BuilderCardModalComponent,
  STRIPE_LOADER,
  STRIPE_STYLE_TOKENS,
  injectCardModal,
  stripeCardStyle,
} from './builder-card-modal.component';
import { BuilderBillingApiService } from './builder-billing-api.service';
import { LoadBillingCard, LoadBillingOverview } from './builder-billing.actions';
import { BUILDER_COPY } from './builder-copy';
import { CHARGE_TIMING_COPY, DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

const CARD: CardOnFileStatus = { hasCard: true, brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028 };
const copy = DEFAULT_BUILDER_COPY;
const loadStripe = vi.fn();

/** jsdom has no layout: treat enabled controls as tabbable for the CDK focus trap. */
const checkerStub: Partial<InteractivityChecker> = {
  isFocusable: (el: HTMLElement) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0,
  isTabbable: (el: HTMLElement) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0,
  isVisible: () => true,
  isDisabled: (el: HTMLElement) => !!(el as HTMLButtonElement).disabled,
};

/** Poll (with a deadline) for an async UI state — never a fixed sleep. */
async function until(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    TestBed.tick();
  }
}

interface FakeElement {
  mount: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  on: (event: string, cb: (e: { complete: boolean; error?: unknown }) => void) => void;
  emitChange: (complete: boolean, error?: { message: string }) => void;
}

function fakeStripe() {
  let onChange: ((e: { complete: boolean; error?: { message: string } }) => void) | null = null;
  const element: FakeElement = {
    mount: vi.fn(),
    destroy: vi.fn(),
    on: (_event, cb) => {
      onChange = cb;
    },
    emitChange: (complete, error) => onChange?.({ complete, error }),
  };
  const create = vi.fn(() => element);
  const stripe = {
    elements: vi.fn(() => ({ create })),
    confirmCardSetup: vi.fn().mockResolvedValue({ setupIntent: { status: 'succeeded' } }),
  };
  return { stripe, element, create };
}

function setup(opts: { key?: string; contactHref?: string } = {}) {
  TestBed.resetTestingModule();
  const configStub = {
    get: (section: keyof typeof DEFAULT_APP_CONFIG) =>
      section === 'billing'
        ? {
            ...DEFAULT_APP_CONFIG.billing,
            stripePublishableKey: opts.key ?? '',
            questionInvoiceHref: opts.contactHref ?? '',
          }
        : DEFAULT_APP_CONFIG[section],
  } as unknown as ConfigService;
  const api = { createSetupIntent: vi.fn(() => of({ clientSecret: 'seti_test_secret' })) };
  const store = { dispatch: vi.fn(() => of(null)) };
  TestBed.configureTestingModule({
    providers: [
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
      { provide: ConfigService, useValue: configStub },
      { provide: BuilderBillingApiService, useValue: api },
      { provide: Store, useValue: store },
      { provide: InteractivityChecker, useValue: checkerStub },
      { provide: STRIPE_LOADER, useValue: loadStripe },
    ],
  });
  const toast = vi.spyOn(TestBed.inject(UiToastService), 'show').mockReturnValue({} as never);
  const container = TestBed.inject(OverlayContainer).getContainerElement();
  const open = TestBed.runInInjectionContext(() => injectCardModal());
  return { open, api, store, toast, container };
}

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('button[type="submit"]') as HTMLButtonElement;
}

describe('stripeCardStyle (#534)', () => {
  it('maps the design tokens onto the Stripe Element style', () => {
    const tokens: Record<string, string> = {
      [STRIPE_STYLE_TOKENS.text]: ' #1a1612',
      [STRIPE_STYLE_TOKENS.muted]: '#6b5f53',
      [STRIPE_STYLE_TOKENS.danger]: '#b3261e',
      [STRIPE_STYLE_TOKENS.font]: "'Instrument Sans', sans-serif",
    };
    const style = stripeCardStyle((name) => tokens[name] ?? '');
    expect(style.base).toMatchObject({
      color: '#1a1612',
      iconColor: '#6b5f53',
      fontFamily: "'Instrument Sans', sans-serif",
      '::placeholder': { color: '#6b5f53' },
    });
    expect(style.invalid).toEqual({ color: '#b3261e', iconColor: '#b3261e' });
  });

  it('leaves unresolved tokens out so Stripe defaults apply', () => {
    const style = stripeCardStyle(() => '');
    expect(style.base).not.toHaveProperty('color');
    expect(style.base).not.toHaveProperty('fontFamily');
    expect(style.invalid).toEqual({});
  });
});

describe('BuilderCardModalComponent (#534)', () => {
  let ref: DialogRef<boolean, BuilderCardModalComponent> | null = null;

  beforeEach(() => {
    loadStripe.mockReset();
  });

  afterEach(() => {
    ref?.close();
    ref = null;
    document.documentElement.style.removeProperty('--text');
  });

  it('without a publishable key: no outage note, the saved card keeps working (AC2)', async () => {
    const { open, api, container } = setup({ contactHref: 'mailto:billing@example.com' });
    ref = open(CARD);
    await until(() => text(container).includes(copy.cardModalUnavailableWithCard), 'unavailable copy');

    expect(text(container)).toContain(copy.cardModalTitleUpdate);
    expect(text(container)).toContain('Replacing Visa •••• 4242.');
    expect(text(container)).not.toMatch(/isn’t available yet/);
    expect(container.querySelector('.card-modal__element')).toBeNull();
    expect(saveButton(container)).toBeNull();
    expect(container.querySelector('a.card-modal__link')?.getAttribute('href')).toBe('mailto:billing@example.com');
    expect(loadStripe).not.toHaveBeenCalled();
    expect(api.createSetupIntent).not.toHaveBeenCalled();
  });

  it('without a key and no card: "Add a card" title and contact copy, link hidden when unset', async () => {
    const { open, container } = setup();
    ref = open({ hasCard: false });
    await until(() => text(container).includes(copy.cardModalUnavailableNoCard), 'no-card copy');
    expect(container.querySelector('h2')?.textContent).toContain(copy.cardModalTitleAdd);
    expect(container.querySelector('a.card-modal__link')).toBeNull();
  });

  it('without a key and an unknown card: body matches the "Update" heading', async () => {
    const { open, container } = setup();
    ref = open();
    await until(() => text(container).includes(copy.cardModalUnavailableWithCard), 'update copy');
    expect(container.querySelector('h2')?.textContent).toContain(copy.cardModalTitleUpdate);
    expect(text(container)).not.toContain(copy.cardModalUnavailableNoCard);
  });

  it('mounts a token-styled card Element with reassurance + charge-timing copy', async () => {
    document.documentElement.style.setProperty('--text', '#123456');
    const { stripe, create, element } = fakeStripe();
    loadStripe.mockResolvedValue(stripe as never);
    const { open, api, container } = setup({ key: 'pk_test_stub' });
    ref = open(CARD);
    await until(() => element.mount.mock.calls.length > 0, 'element mounted');

    expect(loadStripe).toHaveBeenCalledWith('pk_test_stub');
    expect(api.createSetupIntent).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith('card', {
      style: expect.objectContaining({ base: expect.objectContaining({ color: '#123456' }) }),
    });
    expect(element.mount).toHaveBeenCalledWith(container.querySelector('.card-modal__element'));
    expect(text(container)).toContain(copy.cardModalReassurance);
    expect(text(container)).toContain(CHARGE_TIMING_COPY);
  });

  it('enables Save only for a complete card; success refreshes billing, toasts and closes true', async () => {
    const { stripe, element } = fakeStripe();
    loadStripe.mockResolvedValue(stripe as never);
    const { open, store, toast, container } = setup({ key: 'pk_test_stub' });
    ref = open(CARD);
    let result: boolean | undefined;
    ref.closed.subscribe((r) => (result = r));
    await until(() => element.mount.mock.calls.length > 0, 'element mounted');

    expect(saveButton(container).disabled).toBe(true);
    element.emitChange(true);
    await until(() => !saveButton(container).disabled, 'save enabled');

    saveButton(container).click();
    await until(() => result !== undefined, 'modal closed');

    expect(stripe.confirmCardSetup).toHaveBeenCalledWith('seti_test_secret', {
      payment_method: { card: element },
    });
    expect(store.dispatch).toHaveBeenCalledWith([expect.any(LoadBillingCard), expect.any(LoadBillingOverview)]);
    expect(toast).toHaveBeenCalledWith({ message: copy.billingCardSaved, tone: 'success' });
    expect(result).toBe(true);
    expect(element.destroy).toHaveBeenCalled();
  });

  it('keeps the form open with an error when Stripe declines the card', async () => {
    const { stripe, element } = fakeStripe();
    stripe.confirmCardSetup.mockResolvedValue({ error: { message: 'declined' } } as never);
    loadStripe.mockResolvedValue(stripe as never);
    const { open, store, container } = setup({ key: 'pk_test_stub' });
    ref = open();
    await until(() => element.mount.mock.calls.length > 0, 'element mounted');
    element.emitChange(true);
    await until(() => !saveButton(container).disabled, 'save enabled');

    saveButton(container).click();
    await until(() => text(container).includes(copy.billingSaveFailed), 'save error');

    expect(container.querySelector('.card-modal__element')).not.toBeNull();
    expect(store.dispatch).not.toHaveBeenCalled();

    // Editing the card after a decline clears the stale banner.
    element.emitChange(false);
    await until(() => !text(container).includes(copy.billingSaveFailed), 'save error cleared');
  });

  it('announces Stripe inline validation messages and clears them once valid', async () => {
    const { stripe, element } = fakeStripe();
    loadStripe.mockResolvedValue(stripe as never);
    const { open, container } = setup({ key: 'pk_test_stub' });
    ref = open(CARD);
    await until(() => element.mount.mock.calls.length > 0, 'element mounted');

    const live = container.querySelector('#card-modal-inline-error') as HTMLElement;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(container.querySelector('.card-modal__element')?.getAttribute('aria-describedby')).toBe(
      'card-modal-inline-error',
    );

    element.emitChange(false, { message: 'Your card number is incomplete.' });
    await until(() => live.textContent?.includes('Your card number is incomplete.') ?? false, 'inline error');
    expect(saveButton(container).disabled).toBe(true);

    element.emitChange(true);
    await until(() => (live.textContent ?? '').trim() === '', 'inline error cleared');
  });

  it('offers a retry when Stripe.js fails to load', async () => {
    const { stripe, element } = fakeStripe();
    loadStripe.mockResolvedValueOnce(null).mockResolvedValueOnce(stripe as never);
    const { open, container } = setup({ key: 'pk_test_stub' });
    ref = open(CARD);
    await until(() => text(container).includes(copy.cardModalLoadError), 'load error');

    (container.querySelector('.card-modal__alert button') as HTMLButtonElement).click();
    await until(() => element.mount.mock.calls.length > 0, 'element mounted after retry');
    expect(text(container)).not.toContain(copy.cardModalLoadError);
  });

  it('Cancel closes without a result', async () => {
    const { stripe, element } = fakeStripe();
    loadStripe.mockResolvedValue(stripe as never);
    const { open, container } = setup({ key: 'pk_test_stub' });
    ref = open(CARD);
    let closed = false;
    let result: boolean | undefined = false;
    ref.closed.subscribe((r) => {
      closed = true;
      result = r;
    });
    await until(() => element.mount.mock.calls.length > 0, 'element mounted');

    const cancel = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(copy.billingCancel),
    ) as HTMLButtonElement;
    cancel.click();
    await until(() => closed, 'closed');
    expect(result).toBeUndefined();
  });
});
