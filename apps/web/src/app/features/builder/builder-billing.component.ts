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
import { SeoService } from '../../core/seo/seo.service';
import { BuilderBillingApiService } from './builder-billing-api.service';
import {
  ClearBillingState,
  LoadBillingCard,
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
  protected readonly copy = this.config.get('copy').builder;

  protected readonly card = this.store.selectSignal(BuilderBillingState.card);
  protected readonly cardStatus = this.store.selectSignal(
    BuilderBillingState.cardStatus,
  );

  /** True while the card form is visible. */
  protected readonly formOpen = signal(false);
  /** True while Stripe confirms the setup (disables submit). */
  protected readonly saving = signal(false);
  /** Durable success message after the card is saved. */
  protected readonly saveSuccess = signal(false);
  /** True when the card form failed to initialize or save. */
  protected readonly saveError = signal(false);

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
  }

  /** The Stripe publishable key; empty = card setup unavailable. */
  protected publishableKey(): string {
    return this.config.get('billing').stripePublishableKey;
  }

  protected retryLoad(): void {
    this.saveError.set(false);
    this.store.dispatch(new LoadBillingCard());
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
