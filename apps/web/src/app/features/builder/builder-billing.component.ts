import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { Store } from '@ngxs/store';
import { loadStripe } from '@stripe/stripe-js';
import type { Stripe, StripeCardElement } from '@stripe/stripe-js';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '../../core/config/config.service';
import { BUILDER_COPY } from './builder-copy';
import { SeoService } from '../../core/seo/seo.service';
import { BuilderBillingApiService } from './builder-billing-api.service';
import {
  BUILDER_PAYMENT_METHODS,
  isBuilderPaymentMethod,
  paymentMethodLabel,
  type BuilderPaymentMethod,
} from './builder-payment-methods';
import {
  ClearBillingState,
  LoadBillingCard,
  LoadDefaultPaymentMethod,
  SetDefaultPaymentMethod,
} from './builder-billing.actions';
import { BuilderBillingState } from './builder-billing.state';

/**
 * Builder billing page (billing/02, BILL-02): `/builder/billing`.
 *
 * Card-on-file status card + Add/Update card flow. Stripe Elements
 * tokenizes the PAN in the browser — it never touches our backend. The
 * component:
 *
 * 1. Loads the card status from NGXS (brand/last4/expiry only).
 * 2. On "Add card" / "Update card": fetches a SetupIntent client secret
 *    from the backend, mounts the Stripe card element, and confirms the
 *    setup with `stripe.confirmCardSetup`.
 * 3. On success: refreshes the NGXS status and shows a durable success
 *    message.
 *
 * Fail-closed: no publishable key in config (or Stripe.js failing to
 * load) renders the "unavailable" notice instead of the form.
 */
@Component({
  selector: 'app-builder-billing',
  standalone: true,
  imports: [],
  templateUrl: './builder-billing.component.html',
  styleUrls: ['./builder-billing.component.scss'],
})
export class BuilderBillingComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly api = inject(BuilderBillingApiService);
  private readonly config = inject(ConfigService);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('cardElement') private cardElementRef?: ElementRef<HTMLElement>;

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(BUILDER_COPY);

  protected readonly card = this.store.selectSignal(BuilderBillingState.card);
  protected readonly cardStatus = this.store.selectSignal(
    BuilderBillingState.cardStatus,
  );
  protected readonly defaultMethod = this.store.selectSignal(
    BuilderBillingState.defaultMethod,
  );
  protected readonly defaultMethodStatus = this.store.selectSignal(
    BuilderBillingState.defaultMethodStatus,
  );
  protected readonly defaultMethodSaveStatus = this.store.selectSignal(
    BuilderBillingState.defaultMethodSaveStatus,
  );

  /** True while the card form is visible. */
  protected readonly formOpen = signal(false);
  /** True while Stripe confirms the setup (disables submit). */
  protected readonly saving = signal(false);
  /** Durable success message after the card is saved. */
  protected readonly saveSuccess = signal(false);
  /** True when the card form failed to initialize or save. */
  protected readonly saveError = signal(false);
  /**
   * Durable confirmation after the default payment method is saved.
   * Cleared on the next change.
   */
  protected readonly defaultMethodSaved = signal(false);

  /**
   * Staged (not yet applied) default payment method. The select only stages
   * a choice — nothing is saved until the builder clicks Apply (Karan
   * 2026-10-02: no auto-save on select). `null` means no pending change;
   * the select then shows the saved method.
   */
  protected readonly pendingDefaultMethod = signal<BuilderPaymentMethod | null>(null);

  private stripe: Stripe | null = null;
  private cardElement: StripeCardElement | null = null;

  constructor() {
    this.seo.setPage({
      title: 'Billing — Feasly builder portal',
      description: 'Card on file for Feasly commission billing.',
      path: '/builder/billing',
    });
    // Keep the billing slice fresh on logout.
    this.destroyRef.onDestroy(() => {
      this.store.dispatch(new ClearBillingState());
      this.cardElement?.unmount();
    });
  }

  ngOnInit(): void {
    this.store.dispatch(new LoadBillingCard());
    this.store.dispatch(new LoadDefaultPaymentMethod());
  }

  /** The Stripe publishable key; empty = card setup unavailable. */
  protected publishableKey(): string {
    return this.config.get('billing').stripePublishableKey;
  }

  protected retryLoad(): void {
    this.saveError.set(false);
    this.store.dispatch(new LoadBillingCard());
  }

  protected retryDefaultMethodLoad(): void {
    this.store.dispatch(new LoadDefaultPaymentMethod());
  }

  /** Payment-method options in display order (billing/12). */
  protected defaultMethodOptions(): readonly BuilderPaymentMethod[] {
    return BUILDER_PAYMENT_METHODS;
  }

  /**
   * Buyer-grade option label. The card option carries the on-file last4
   * when a card exists; otherwise it is disabled (see
   * isCardOptionDisabled).
   */
  protected defaultMethodOptionLabel(method: BuilderPaymentMethod): string {
    if (method === 'card') {
      const card = this.card();
      if (card?.hasCard && card.last4) {
        return paymentMethodLabel(method, this.copy, card.last4);
      }
      return this.copy.billingMethodCardNoCard;
    }
    return paymentMethodLabel(method, this.copy);
  }

  /** The card option is unusable until a card is on file. */
  protected isCardOptionDisabled(): boolean {
    return !this.card()?.hasCard;
  }

  /**
   * Persists the new default on change (billing/12). The select is
   * disabled while the PUT is in flight; the saved confirmation is
   * durable until the next change.
   */
  /**
   * The method the select shows: the staged choice while one is pending,
   * otherwise the saved method.
   */
  protected displayedDefaultMethod(): BuilderPaymentMethod | null {
    return this.pendingDefaultMethod() ?? this.defaultMethod();
  }

  /** Apply is only meaningful when a real change is staged. */
  protected canApplyDefaultMethod(): boolean {
    const pending = this.pendingDefaultMethod();
    const saved = this.defaultMethod();
    return pending !== null && pending !== saved;
  }

  /**
   * Stages the dropdown choice without saving (Karan 2026-10-02: changing
   * the default method must not apply on select). Re-selecting the saved
   * method clears the staged change.
   */
  protected onDefaultMethodSelect(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (!isBuilderPaymentMethod(value)) {
      return;
    }
    this.defaultMethodSaved.set(false);
    this.pendingDefaultMethod.set(value === this.defaultMethod() ? null : value);
  }

  /** Discards the staged choice; the select snaps back to the saved method. */
  protected resetPendingDefaultMethod(): void {
    this.pendingDefaultMethod.set(null);
  }

  /**
   * Applies the staged default payment method. Disabled until the staged
   * choice differs from the saved method. On success the saved method
   * updates and a confirmation shows; on failure the select reverts to
   * the saved value.
   */
  protected async applyDefaultMethod(): Promise<void> {
    const pending = this.pendingDefaultMethod();
    if (pending === null || pending === this.defaultMethod()) {
      return;
    }
    this.defaultMethodSaved.set(false);
    await firstValueFrom(
      this.store.dispatch(new SetDefaultPaymentMethod(pending)),
    );
    // The staged choice is consumed either way: on success the select
    // shows the new saved method; on failure it reverts to the old one.
    this.pendingDefaultMethod.set(null);
    if (
      this.store.selectSnapshot(
        BuilderBillingState.defaultMethodSaveStatus,
      ) === 'idle'
    ) {
      this.defaultMethodSaved.set(true);
    }
  }

  /** "Saved — new invoices will use cheque." */
  protected defaultMethodSavedText(): string {
    const method = this.defaultMethod();
    const label = method
      ? this.defaultMethodOptionLabel(method).toLowerCase()
      : '';
    return this.copy.billingDefaultMethodSaved.replace('{method}', label);
  }

  /** Opens the card form: fetches a SetupIntent and mounts Elements. */
  protected async openForm(): Promise<void> {
    if (this.saving()) {
      return;
    }
    this.saveSuccess.set(false);
    this.saveError.set(false);

    const publishableKey = this.publishableKey();
    if (!publishableKey) {
      this.saveError.set(true);
      return;
    }

    try {
      this.stripe = await loadStripe(publishableKey);
      if (!this.stripe) {
        this.saveError.set(true);
        return;
      }
      const intent = await firstValueFrom(this.api.createSetupIntent());
      this.setupIntentClientSecret = intent.clientSecret;
      this.formOpen.set(true);
      // Mount after the view renders the container.
      queueMicrotask(() => this.mountCardElement());
    } catch {
      this.saveError.set(true);
    }
  }

  private setupIntentClientSecret: string | null = null;

  private mountCardElement(): void {
    const host = this.cardElementRef?.nativeElement;
    if (!this.stripe || !host) {
      this.saveError.set(true);
      return;
    }
    this.cardElement?.unmount();
    const elements = this.stripe.elements();
    this.cardElement = elements.create('card');
    this.cardElement.mount(host);
  }

  /** Confirms the card setup with Stripe, then refreshes the status. */
  protected async saveCard(): Promise<void> {
    if (this.saving() || !this.stripe || !this.cardElement) {
      return;
    }
    const clientSecret = this.setupIntentClientSecret;
    if (!clientSecret) {
      this.saveError.set(true);
      return;
    }
    this.saving.set(true);
    this.saveError.set(false);
    try {
      const result = await this.stripe.confirmCardSetup(clientSecret, {
        payment_method: { card: this.cardElement },
      });
      if (result.error) {
        this.saveError.set(true);
        return;
      }
      this.formOpen.set(false);
      this.cardElement.unmount();
      this.cardElement = null;
      await firstValueFrom(this.store.dispatch(new LoadBillingCard()));
      this.saveSuccess.set(true);
    } catch {
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  protected cancelForm(): void {
    this.formOpen.set(false);
    this.saveError.set(false);
    this.cardElement?.unmount();
    this.cardElement = null;
  }
}
