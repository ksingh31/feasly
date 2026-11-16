/**
 * Card modal (#534) tests.
 *
 * AC1 — the modal is the one card form, opened through `injectCardModal`
 * (Money, failed-card strip, invoice detail and Billing specs assert their
 * triggers call it). AC2 — no publishable key never renders the
 * contradictory "card setup isn't available" outage note; the modal explains
 * the contact route to change a saved card. Plus: token-styled Stripe Element,
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
import { of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIMULATED_PAYMENTS_NOTICE, SIMULATED_TEST_CARDS } from '@feasly/contracts';
import type { CardOnFileStatus, SetupIntentResponse, SimulatedIntentResponse } from '@feasly/contracts';
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

interface SetupOpts {
  key?: string;
  contactHref?: string;
  /** SetupIntent response (or failure); defaults to the Stripe provider. */
  intent?: () => Observable<SetupIntentResponse>;
  confirm?: () => Observable<SimulatedIntentResponse>;
  authenticate?: () => Observable<SimulatedIntentResponse>;
}

const STRIPE_INTENT: SetupIntentResponse = {
  setupIntentId: 'seti_test',
  clientSecret: 'seti_test_secret',
  provider: 'stripe',
};
const SIM_INTENT: SetupIntentResponse = {
  setupIntentId: 'seti_sim_1',
  clientSecret: 'seti_sim_1_secret_x',
  provider: 'simulated',
};

function setup(opts: SetupOpts = {}) {
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
  const api = {
    createSetupIntent: vi.fn(opts.intent ?? (() => of(STRIPE_INTENT))),
    simulatedConfirmSetup: vi.fn(
      opts.confirm ?? (() => of<SimulatedIntentResponse>({ intentId: 'seti_sim_1', status: 'succeeded' })),
    ),
    simulatedAuthenticate: vi.fn(
      opts.authenticate ?? (() => of<SimulatedIntentResponse>({ intentId: 'seti_sim_1', status: 'succeeded' })),
    ),
  };
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

  it('without a publishable key: no outage note, contact copy to change the card (AC2)', async () => {
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
    // #791: the SetupIntent is asked for (only the simulated provider could
    // take a card without a key); a Stripe answer keeps the contact copy.
    expect(api.createSetupIntent).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="simulated-card-picker"]')).toBeNull();
  });

  it('without a key and a failed SetupIntent: still the calm contact copy, never an outage', async () => {
    const { open, container } = setup({ intent: () => throwError(() => new Error('boom')) });
    ref = open(CARD);
    await until(() => text(container).includes(copy.cardModalUnavailableWithCard), 'unavailable copy');
    expect(text(container)).not.toContain(copy.cardModalLoadError);
    expect(saveButton(container)).toBeNull();
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
    // #791 AC2: the Stripe provider never renders the test-card picker.
    expect(container.querySelector('[data-testid="simulated-card-picker"]')).toBeNull();
    expect(text(container)).not.toContain(SIMULATED_PAYMENTS_NOTICE);
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

  describe('simulated provider (#791)', () => {
    function radios(container: HTMLElement): HTMLInputElement[] {
      return Array.from(container.querySelectorAll<HTMLInputElement>('input[name="simulated-test-card"]'));
    }

    function pick(container: HTMLElement, number: string): void {
      const radio = radios(container).find((r) => r.value === number);
      if (!radio) throw new Error(`no radio for ${number}`);
      radio.click();
    }

    function button(container: HTMLElement, testId: string): HTMLButtonElement {
      return container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement;
    }

    it('shows the test-card picker + notice without loading Stripe.js (no key)', async () => {
      const { open, container } = setup({ intent: () => of(SIM_INTENT) });
      ref = open(CARD);
      await until(() => radios(container).length > 0, 'picker');

      expect(radios(container).map((r) => r.value)).toEqual(SIMULATED_TEST_CARDS.map((c) => c.number));
      for (const card of SIMULATED_TEST_CARDS) expect(text(container)).toContain(card.label);
      expect(container.querySelector('[data-testid="simulated-notice"]')?.textContent).toContain(
        SIMULATED_PAYMENTS_NOTICE,
      );
      expect(container.querySelector('.card-modal__element')).toBeNull();
      expect(loadStripe).not.toHaveBeenCalled();
      // The "goes straight to Stripe" line would be untrue in test mode.
      expect(text(container)).not.toContain(copy.cardModalReassurance);
      expect(text(container)).toContain(CHARGE_TIMING_COPY);
    });

    it('never loads Stripe.js when the API is simulated, even with a key', async () => {
      const { open, container } = setup({ key: 'pk_test_stub', intent: () => of(SIM_INTENT) });
      ref = open(CARD);
      await until(() => radios(container).length > 0, 'picker');
      expect(loadStripe).not.toHaveBeenCalled();
    });

    it.each(SIMULATED_TEST_CARDS.filter((c) => c.behavior !== 'requires_3ds'))(
      'saves $label via confirm-setup, refreshes billing and closes true',
      async (card) => {
        const { open, api, store, toast, container } = setup({ intent: () => of(SIM_INTENT) });
        ref = open(CARD);
        let result: boolean | undefined;
        ref.closed.subscribe((r) => (result = r));
        await until(() => radios(container).length > 0, 'picker');

        expect(saveButton(container).disabled).toBe(true);
        pick(container, card.number);
        await until(() => !saveButton(container).disabled, 'save enabled');
        saveButton(container).click();
        await until(() => result !== undefined, 'closed');

        expect(api.simulatedConfirmSetup).toHaveBeenCalledWith({ setupIntentId: 'seti_sim_1', cardNumber: card.number });
        expect(store.dispatch).toHaveBeenCalledWith([expect.any(LoadBillingCard), expect.any(LoadBillingOverview)]);
        expect(toast).toHaveBeenCalledWith({ message: copy.billingCardSaved, tone: 'success' });
        expect(result).toBe(true);
      },
    );

    it('3DS card: Complete on the challenge step saves the card', async () => {
      const { open, api, container } = setup({
        intent: () => of(SIM_INTENT),
        confirm: () => of({ intentId: 'seti_sim_1', status: 'requires_action', nextAction: 'three_d_secure' }),
      });
      ref = open(CARD);
      let result: boolean | undefined;
      ref.closed.subscribe((r) => (result = r));
      await until(() => radios(container).length > 0, 'picker');
      pick(container, '4000002760003184');
      await until(() => !saveButton(container).disabled, 'save enabled');
      saveButton(container).click();

      await until(() => !!button(container, 'simulated-challenge-complete'), 'challenge step');
      expect(text(container)).toContain(copy.simulated.challengeHeading);
      expect(saveButton(container)).toBeNull();

      button(container, 'simulated-challenge-complete').click();
      await until(() => result !== undefined, 'closed');
      expect(api.simulatedAuthenticate).toHaveBeenCalledWith({ intentId: 'seti_sim_1', outcome: 'complete' });
      expect(result).toBe(true);
    });

    it('3DS card: Fail keeps the modal open with the failure note and the picker back', async () => {
      const { open, api, store, container } = setup({
        intent: () => of(SIM_INTENT),
        confirm: () => of({ intentId: 'seti_sim_1', status: 'requires_action', nextAction: 'three_d_secure' }),
        authenticate: () => of({ intentId: 'seti_sim_1', status: 'requires_payment_method' }),
      });
      ref = open(CARD);
      await until(() => radios(container).length > 0, 'picker');
      pick(container, '4000002760003184');
      await until(() => !saveButton(container).disabled, 'save enabled');
      saveButton(container).click();
      await until(() => !!button(container, 'simulated-challenge-fail'), 'challenge step');

      button(container, 'simulated-challenge-fail').click();
      await until(() => text(container).includes(copy.simulated.setupChallengeFailed), 'failure note');
      expect(api.simulatedAuthenticate).toHaveBeenCalledWith({ intentId: 'seti_sim_1', outcome: 'fail' });
      expect(radios(container).length).toBe(SIMULATED_TEST_CARDS.length);
      expect(store.dispatch).not.toHaveBeenCalled();

      // Picking another card clears the stale note.
      pick(container, '4242424242424242');
      await until(() => !text(container).includes(copy.simulated.setupChallengeFailed), 'note cleared');
    });

    it('a failed authenticate call keeps the challenge step with an error', async () => {
      const { open, container } = setup({
        intent: () => of(SIM_INTENT),
        confirm: () => of({ intentId: 'seti_sim_1', status: 'requires_action' }),
        authenticate: () => throwError(() => ({ code: 'http_500', message: 'x', retryable: true })),
      });
      ref = open(CARD);
      await until(() => radios(container).length > 0, 'picker');
      pick(container, '4000002760003184');
      await until(() => !saveButton(container).disabled, 'save enabled');
      saveButton(container).click();
      await until(() => !!button(container, 'simulated-challenge-complete'), 'challenge step');
      button(container, 'simulated-challenge-complete').click();
      await until(() => text(container).includes(copy.simulated.challengeError), 'challenge error');
      expect(button(container, 'simulated-challenge-complete').disabled).toBe(false);
    });

    it('a failed confirm-setup shows the save error and keeps the picker', async () => {
      const { open, container } = setup({
        intent: () => of(SIM_INTENT),
        confirm: () => throwError(() => ({ code: 'http_409', message: 'x', retryable: false })),
      });
      ref = open(CARD);
      await until(() => radios(container).length > 0, 'picker');
      pick(container, '4242424242424242');
      await until(() => !saveButton(container).disabled, 'save enabled');
      saveButton(container).click();
      await until(() => text(container).includes(copy.billingSaveFailed), 'save error');
      expect(radios(container).length).toBe(SIMULATED_TEST_CARDS.length);
    });
  });
});
