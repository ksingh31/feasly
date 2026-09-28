import { inject, Injectable } from '@angular/core';
import { of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import type { CardOnFileStatus } from '@feasly/contracts';
import { BuilderBillingApiService } from './builder-billing-api.service';
import {
  ClearBillingState,
  LoadBillingCard,
} from './builder-billing.actions';

/** Loading lifecycle for the card-on-file status. */
export type BillingCardStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface BuilderBillingStateModel {
  /** Card-on-file status, memory-only (no PAN ever reaches the client). */
  card: CardOnFileStatus | null;
  cardStatus: BillingCardStatus;
}

const defaults: BuilderBillingStateModel = {
  card: null,
  cardStatus: 'idle',
};

/**
 * Builder billing state (billing/02, BILL-02): the single source of truth
 * for the `/builder/billing` card-on-file section.
 *
 * Memory-only — the card summary (brand/last4/expiry) is display-safe and
 * never persisted. Stripe Elements tokenizes the PAN in the browser; the
 * component calls `confirmCardSetup` directly with the client secret from
 * the API and dispatches `LoadBillingCard` to refresh the status.
 */
@State<BuilderBillingStateModel>({
  name: 'builderBilling',
  defaults,
})
@Injectable()
export class BuilderBillingState {
  private readonly api = inject(BuilderBillingApiService);

  @Selector()
  static card(state: BuilderBillingStateModel): CardOnFileStatus | null {
    return state.card;
  }

  @Selector()
  static cardStatus(state: BuilderBillingStateModel): BillingCardStatus {
    return state.cardStatus;
  }

  @Action(LoadBillingCard)
  loadCard(ctx: StateContext<BuilderBillingStateModel>) {
    ctx.patchState({ cardStatus: 'loading' });
    return this.api.getCard().pipe(
      tap((card) => ctx.patchState({ card, cardStatus: 'ready' })),
      catchError(() => {
        ctx.patchState({ cardStatus: 'error' });
        return of(null);
      }),
    );
  }

  @Action(ClearBillingState)
  clear(ctx: StateContext<BuilderBillingStateModel>) {
    ctx.setState(defaults);
  }
}
