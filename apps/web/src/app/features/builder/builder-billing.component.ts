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
import { firstValueFrom } from 'rxjs';
import { BUILDER_COPY } from './builder-copy';
import { SeoService } from '../../core/seo/seo.service';
import { injectCardModal } from './builder-card-modal.component';
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
 * Card-on-file status (brand/last4/expiry from NGXS) + the default
 * payment method. "Add card" / "Update card" open the shared card modal
 * (#534) — the Stripe form is never appended to this page, and a missing
 * publishable key is explained inside the modal rather than as an
 * outage-style note next to a working card (review bug B5).
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
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  /** Reference to the default-method select for resetting its DOM value. */
  @ViewChild('defaultMethodSelect') private defaultMethodSelectRef?: ElementRef<HTMLSelectElement>;

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

  /** Opens the shared card modal (#534). */
  private readonly openCardModal = injectCardModal();
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

  constructor() {
    this.seo.setPage({
      title: 'Billing — Feasly builder portal',
      description: 'Card on file for Feasly commission billing.',
      path: '/builder/billing',
    });
    // Keep the billing slice fresh on logout.
    this.destroyRef.onDestroy(() => {
      this.store.dispatch(new ClearBillingState());
    });
  }

  ngOnInit(): void {
    this.store.dispatch(new LoadBillingCard());
    this.store.dispatch(new LoadDefaultPaymentMethod());
  }

  protected retryLoad(): void {
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
    this.syncSelectToSaved();
  }

  /**
   * Resets the select element's DOM value to the saved method. The
   * `[selected]` option bindings don't override a user-set `select.value`
   * property — without this, a discarded/failed staged choice would leave
   * the dropdown visually stuck on the wrong value.
   */
  private syncSelectToSaved(): void {
    const select = this.defaultMethodSelectRef?.nativeElement;
    const saved = this.defaultMethod();
    if (select && saved) {
      select.value = saved;
    }
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
    this.syncSelectToSaved();
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

  /** "Add card" / "Update card": the modal refreshes the card status on save. */
  protected openCard(): void {
    this.openCardModal(this.card());
  }
}
