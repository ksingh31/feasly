import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Store } from '@ngxs/store';
import { firstValueFrom } from 'rxjs';
import type { CardOnFileStatus } from '@feasly/contracts';
import { UiButtonComponent, UiToastService } from '@app/shared/ui';
import { BUILDER_COPY } from './builder-copy';
import { RemoveBillingCard, ResetRemoveBillingCard } from './builder-billing.actions';
import { BuilderBillingState } from './builder-billing.state';
import { cardLifecycleNotice } from './builder-card-lifecycle';

/**
 * Card lifecycle block (#879) shared by the Money and Billing card panels.
 *
 * - Expiry notice ("Your card expires soon" / "Your card has expired")
 *   from the API's `expiresSoon` / `expired` flags, with a "Replace card"
 *   action — the host opens the shared card modal on `replace`.
 * - "Remove card" for builder admins (`canRemove`), behind an inline
 *   confirm step. A 409 (an unpaid invoice is set to be charged to the
 *   card) shows the API's message inline; success flips the card slices to
 *   `{ hasCard: false }` so the host renders "No card on file".
 *
 * State lives in BuilderBillingState; this component only dispatches.
 */
@Component({
  selector: 'app-builder-card-lifecycle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiButtonComponent],
  templateUrl: './builder-card-lifecycle.component.html',
  styleUrl: './builder-card-lifecycle.component.scss',
})
export class BuilderCardLifecycleComponent {
  private readonly store = inject(Store);
  private readonly toasts = inject(UiToastService);
  private readonly injector = inject(Injector);

  /** The card on file (null/`hasCard: false` renders nothing). */
  readonly card = input<CardOnFileStatus | null | undefined>(null);
  /** Builder admins may remove the card; members never see the action. */
  readonly canRemove = input(false);
  /** "Replace card" clicked — the host opens the card modal. */
  readonly replace = output<void>();

  protected readonly copy = inject(BUILDER_COPY).cardLifecycle;
  protected readonly notice = computed(() => cardLifecycleNotice(this.card(), this.copy));
  protected readonly hasCard = computed(() => !!this.card()?.hasCard);

  protected readonly removeStatus = this.store.selectSignal(BuilderBillingState.removeCardStatus);
  protected readonly removeError = this.store.selectSignal(BuilderBillingState.removeCardError);
  /** The inline confirm step is open. */
  protected readonly confirming = signal(false);

  // `read: ElementRef` — the refs sit on `ui-button` hosts, so the default
  // read would be the component instance (no nativeElement).
  private readonly removeButton = viewChild('removeButton', { read: ElementRef<HTMLButtonElement> });
  private readonly keepButton = viewChild('keepButton', { read: ElementRef<HTMLButtonElement> });

  protected startRemove(): void {
    this.store.dispatch(new ResetRemoveBillingCard());
    this.confirming.set(true);
    // Safe default: focus "Keep card" once the confirm step renders.
    afterNextRender(() => this.keepButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected cancelRemove(): void {
    this.confirming.set(false);
    this.store.dispatch(new ResetRemoveBillingCard());
    afterNextRender(() => this.removeButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async confirmRemove(): Promise<void> {
    if (this.removeStatus() === 'removing') {
      return;
    }
    await firstValueFrom(this.store.dispatch(new RemoveBillingCard()));
    if (this.store.selectSnapshot(BuilderBillingState.removeCardStatus) === 'idle') {
      this.confirming.set(false);
      this.toasts.show({ message: this.copy.removed, tone: 'success' });
    }
  }
}
