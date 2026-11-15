import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  InjectionToken,
  Injector,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Store } from '@ngxs/store';
import { loadStripe } from '@stripe/stripe-js';
import type { Stripe, StripeCardElement, StripeElementStyle } from '@stripe/stripe-js';
import { firstValueFrom } from 'rxjs';
import type { CardOnFileStatus } from '@feasly/contracts';
import {
  UiButtonComponent,
  UiModalComponent,
  UiModalService,
  UiToastService,
  enumLabel,
} from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { BUILDER_COPY } from './builder-copy';
import { CHARGE_TIMING_COPY } from './builder-copy.defaults';
import { BuilderBillingApiService } from './builder-billing-api.service';
import { LoadBillingCard, LoadBillingOverview } from './builder-billing.actions';

/**
 * Loads Stripe.js for a publishable key. A token (not a direct import call)
 * so specs swap in a fake without module mocking.
 */
export const STRIPE_LOADER = new InjectionToken<(key: string) => Promise<Stripe | null>>('STRIPE_LOADER', {
  providedIn: 'root',
  factory: () => loadStripe,
});

/** What the opener knows about the current card; `undefined` = unknown. */
export interface BuilderCardModalData {
  card?: CardOnFileStatus | null;
}

/**
 * Modal lifecycle:
 * - `unavailable`: no publishable key — calm "contact us" copy, no form.
 * - `loading`: Stripe.js + SetupIntent in flight.
 * - `ready`: card Element mounted; `saving` while Stripe confirms.
 * - `load-error`: Stripe.js or the SetupIntent failed — retry offered.
 */
export type BuilderCardModalPhase = 'unavailable' | 'loading' | 'ready' | 'saving' | 'load-error';

/** Design tokens the Stripe card Element mirrors (its iframe can't read our CSS). */
export const STRIPE_STYLE_TOKENS = {
  text: '--text',
  muted: '--muted',
  danger: '--danger',
  font: '--font-ui',
} as const;

/**
 * Stripe card Element style built from the design tokens. `token` resolves a
 * CSS custom property (empty when undefined); empty values are left out so
 * Stripe's own defaults apply instead of a broken colour.
 */
export function stripeCardStyle(token: (name: string) => string): StripeElementStyle {
  const pick = (name: string): string | undefined => token(name).trim() || undefined;
  const text = pick(STRIPE_STYLE_TOKENS.text);
  const muted = pick(STRIPE_STYLE_TOKENS.muted);
  const danger = pick(STRIPE_STYLE_TOKENS.danger);
  const font = pick(STRIPE_STYLE_TOKENS.font);
  const clean = <T extends object>(o: T): T =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  return {
    base: clean({
      color: text,
      iconColor: muted,
      fontFamily: font,
      // 16px keeps iOS Safari from zooming into the field on focus.
      fontSize: '16px',
      fontSmoothing: 'antialiased',
      '::placeholder': clean({ color: muted }),
    }),
    invalid: clean({ color: danger, iconColor: danger }),
  };
}

/**
 * Card modal (#534, docs/reviews/2026-11-13-builder.md "Billing clarity").
 *
 * The one place a builder adds or replaces the card on file, opened from
 * Money, the failed-card strip, the invoice detail and the Billing page —
 * the card form is never appended to a page. Stripe Elements tokenizes the
 * card in the browser (the PAN never reaches our API); the Element's style
 * comes from the design tokens.
 *
 * Without a publishable key the modal says card changes are handled by
 * contacting Feasly — it never claims an outage while a saved card still
 * works (review bug B5).
 *
 * On success it refreshes the billing slices, shows a toast and closes with
 * `true`; any other close yields `undefined`.
 */
@Component({
  selector: 'app-builder-card-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiModalComponent, UiButtonComponent],
  templateUrl: './builder-card-modal.component.html',
  styleUrl: './builder-card-modal.component.scss',
})
export class BuilderCardModalComponent implements OnInit {
  private readonly ref = inject<DialogRef<boolean>>(DialogRef);
  private readonly data = inject<BuilderCardModalData | null>(DIALOG_DATA, { optional: true });
  private readonly store = inject(Store);
  private readonly api = inject(BuilderBillingApiService);
  private readonly config = inject(ConfigService);
  private readonly toasts = inject(UiToastService);
  private readonly document = inject(DOCUMENT);
  private readonly loadStripe = inject(STRIPE_LOADER);

  protected readonly copy = inject(BUILDER_COPY);
  protected readonly chargeTiming = CHARGE_TIMING_COPY;
  /** Deploy-configured contact destination; '' hides the link. */
  protected readonly contactHref = this.config.get('billing').questionInvoiceHref;

  protected readonly phase = signal<BuilderCardModalPhase>('loading');
  /** Stripe declined or failed to confirm — the form stays open. */
  protected readonly saveError = signal(false);
  /** The Element reports a complete, valid card. */
  protected readonly complete = signal(false);
  /** Stripe's inline validation message (e.g. "Your card number is incomplete"); '' when valid. */
  protected readonly inlineError = signal('');

  private readonly cardHost = viewChild<ElementRef<HTMLElement>>('cardHost');

  private readonly card = this.data?.card;
  /** A card is (or may be) on file: "Update", otherwise "Add". */
  protected readonly updating = this.card === undefined || this.card === null || this.card.hasCard;

  protected readonly heading = this.updating ? this.copy.cardModalTitleUpdate : this.copy.cardModalTitleAdd;

  /** "Visa •••• 4242", only when the opener knows the saved card. */
  protected readonly currentCard = computed(() => {
    const c = this.card;
    if (!c?.hasCard) return null;
    const label = [enumLabel(c.brand ?? ''), '••••', c.last4 ?? '—'].join(' ').trim();
    return this.copy.cardModalCurrent.replace('{card}', label);
  });

  /** Keyed off `updating` so the body never contradicts the heading. */
  protected readonly unavailableBody = this.updating
    ? this.copy.cardModalUnavailableWithCard
    : this.copy.cardModalUnavailableNoCard;

  private stripe: Stripe | null = null;
  private element: StripeCardElement | null = null;
  private clientSecret: string | null = null;

  constructor() {
    // Mount once the ready template has rendered the host.
    effect(() => {
      const host = this.cardHost()?.nativeElement;
      if (host && this.stripe && !this.element) {
        this.mount(host);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.element?.destroy();
      this.element = null;
    });
  }

  ngOnInit(): void {
    void this.start();
  }

  /** Loads Stripe.js and a SetupIntent; also the retry path. */
  protected async start(): Promise<void> {
    const key = this.config.get('billing').stripePublishableKey;
    if (!key) {
      this.phase.set('unavailable');
      return;
    }
    this.phase.set('loading');
    try {
      const stripe = await this.loadStripe(key);
      if (!stripe) {
        this.phase.set('load-error');
        return;
      }
      const intent = await firstValueFrom(this.api.createSetupIntent());
      this.stripe = stripe;
      this.clientSecret = intent.clientSecret;
      this.phase.set('ready');
    } catch {
      this.phase.set('load-error');
    }
  }

  private mount(host: HTMLElement): void {
    if (!this.stripe) return;
    const styles = this.document.defaultView?.getComputedStyle(this.document.documentElement);
    const style = stripeCardStyle((name) => styles?.getPropertyValue(name) ?? '');
    this.element = this.stripe.elements().create('card', { style });
    this.element.on('change', (event) => {
      this.complete.set(event.complete);
      this.inlineError.set(event.error?.message ?? '');
      // Any edit after a decline clears the stale banner.
      this.saveError.set(false);
    });
    this.element.mount(host);
  }

  protected async save(): Promise<void> {
    if (this.phase() !== 'ready' || !this.stripe || !this.element || !this.clientSecret) {
      return;
    }
    this.phase.set('saving');
    this.saveError.set(false);
    try {
      const result = await this.stripe.confirmCardSetup(this.clientSecret, {
        payment_method: { card: this.element },
      });
      if (result.error) {
        this.saveError.set(true);
        this.phase.set('ready');
        return;
      }
      this.store.dispatch([new LoadBillingCard(), new LoadBillingOverview()]);
      this.toasts.show({ message: this.copy.billingCardSaved, tone: 'success' });
      this.ref.close(true);
    } catch {
      this.saveError.set(true);
      this.phase.set('ready');
    }
  }

  protected cancel(): void {
    this.ref.close();
  }
}

/**
 * Returns an opener for the card modal, bound to the caller's injector so
 * the modal sees the builder-scoped copy. Call in an injection context:
 *
 *   private readonly openCardModal = injectCardModal();
 *   …(click)="openCardModal(card)"
 */
export function injectCardModal(): (card?: CardOnFileStatus | null) => DialogRef<boolean, BuilderCardModalComponent> {
  const modals = inject(UiModalService);
  const injector = inject(Injector);
  return (card) =>
    modals.open<BuilderCardModalComponent, boolean, BuilderCardModalData>(BuilderCardModalComponent, {
      data: { card },
      size: 'sm',
      // A half-typed card shouldn't vanish on a stray tap; Esc and × still close.
      dismissOnScrim: false,
      injector,
    });
}
