import { inject, Injectable } from '@angular/core';
import { of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import type { ApiError, BuilderBillingOverviewResponse, CardOnFileStatus } from '@feasly/contracts';
import { BuilderBillingApiService } from './builder-billing-api.service';
import type { BuilderPaymentMethod } from './builder-payment-methods';
import {
  ClearBillingState,
  LoadBillingCard,
  LoadBillingOverview,
  LoadDefaultPaymentMethod,
  RemoveBillingCard,
  ResetRemoveBillingCard,
  SetDefaultPaymentMethod,
} from './builder-billing.actions';

/** #879: DELETE /billing/card lifecycle. */
export type RemoveCardStatus = 'idle' | 'removing' | 'error';

/** The API's 409 code when an unpaid card invoice blocks removal. */
const CONFLICT_CODE = 'CONFLICT';

/** Loading lifecycle for the card-on-file status. */
export type BillingCardStatus = 'idle' | 'loading' | 'ready' | 'error';

/** PUT lifecycle for the default payment method. */
export type DefaultPaymentMethodSaveStatus = 'idle' | 'saving' | 'error';

export interface BuilderBillingStateModel {
  /** Card-on-file status, memory-only (no PAN ever reaches the client). */
  card: CardOnFileStatus | null;
  cardStatus: BillingCardStatus;
  /**
   * Builder-level default payment method for new invoices (billing/12).
   * Null until loaded.
   */
  defaultMethod: BuilderPaymentMethod | null;
  defaultMethodStatus: BillingCardStatus;
  defaultMethodSaveStatus: DefaultPaymentMethodSaveStatus;
  /** Money page header (#531). Memory-only; null until loaded. */
  overview: BuilderBillingOverviewResponse | null;
  overviewStatus: BillingCardStatus;
  /** #879: remove-card request lifecycle. */
  removeCardStatus: RemoveCardStatus;
  /**
   * #879: the API's actionable 409 message (which invoice blocks removal);
   * null for any other failure (the UI shows generic copy).
   */
  removeCardError: string | null;
}

const defaults: BuilderBillingStateModel = {
  card: null,
  cardStatus: 'idle',
  defaultMethod: null,
  defaultMethodStatus: 'idle',
  defaultMethodSaveStatus: 'idle',
  overview: null,
  overviewStatus: 'idle',
  removeCardStatus: 'idle',
  removeCardError: null,
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

  @Selector()
  static defaultMethod(
    state: BuilderBillingStateModel,
  ): BuilderPaymentMethod | null {
    return state.defaultMethod;
  }

  @Selector()
  static defaultMethodStatus(
    state: BuilderBillingStateModel,
  ): BillingCardStatus {
    return state.defaultMethodStatus;
  }

  @Selector()
  static defaultMethodSaveStatus(
    state: BuilderBillingStateModel,
  ): DefaultPaymentMethodSaveStatus {
    return state.defaultMethodSaveStatus;
  }

  @Selector()
  static overview(
    state: BuilderBillingStateModel,
  ): BuilderBillingOverviewResponse | null {
    return state.overview;
  }

  @Selector()
  static overviewStatus(state: BuilderBillingStateModel): BillingCardStatus {
    return state.overviewStatus;
  }

  @Selector()
  static removeCardStatus(state: BuilderBillingStateModel): RemoveCardStatus {
    return state.removeCardStatus;
  }

  @Selector()
  static removeCardError(state: BuilderBillingStateModel): string | null {
    return state.removeCardError;
  }

  /**
   * #879: DELETE the card on file. Success writes the API's
   * `{ hasCard: false }` into both the card slice and the Money overview
   * (when one is loaded, and not a flat plan) so both pages show "No card
   * on file" without another round trip.
   */
  @Action(RemoveBillingCard)
  removeCard(ctx: StateContext<BuilderBillingStateModel>) {
    ctx.patchState({ removeCardStatus: 'removing', removeCardError: null });
    return this.api.removeCard().pipe(
      tap((card) => {
        const overview = ctx.getState().overview;
        ctx.patchState({
          card,
          cardStatus: 'ready',
          removeCardStatus: 'idle',
          overview:
            overview && overview.card !== null ? { ...overview, card } : overview,
        });
      }),
      catchError((error: unknown) => {
        const apiError = error as Partial<ApiError> | null;
        const conflict =
          apiError?.code === CONFLICT_CODE && typeof apiError.message === 'string'
            ? apiError.message
            : null;
        ctx.patchState({ removeCardStatus: 'error', removeCardError: conflict });
        return of(null);
      }),
    );
  }

  @Action(ResetRemoveBillingCard)
  resetRemoveCard(ctx: StateContext<BuilderBillingStateModel>) {
    ctx.patchState({ removeCardStatus: 'idle', removeCardError: null });
  }

  @Action(LoadBillingOverview)
  loadOverview(ctx: StateContext<BuilderBillingStateModel>) {
    ctx.patchState({ overviewStatus: 'loading' });
    return this.api.getOverview().pipe(
      tap((overview) => ctx.patchState({ overview, overviewStatus: 'ready' })),
      catchError(() => {
        ctx.patchState({ overviewStatus: 'error' });
        return of(null);
      }),
    );
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

  @Action(LoadDefaultPaymentMethod)
  loadDefaultMethod(ctx: StateContext<BuilderBillingStateModel>) {
    ctx.patchState({ defaultMethodStatus: 'loading' });
    return this.api.getDefaultPaymentMethod().pipe(
      tap((res) =>
        ctx.patchState({
          defaultMethod: res.defaultMethod,
          defaultMethodStatus: 'ready',
        }),
      ),
      catchError(() => {
        ctx.patchState({ defaultMethodStatus: 'error' });
        return of(null);
      }),
    );
  }

  @Action(SetDefaultPaymentMethod)
  setDefaultMethod(
    ctx: StateContext<BuilderBillingStateModel>,
    action: SetDefaultPaymentMethod,
  ) {
    ctx.patchState({ defaultMethodSaveStatus: 'saving' });
    return this.api.setDefaultPaymentMethod(action.method).pipe(
      tap((res) =>
        ctx.patchState({
          defaultMethod: res.defaultMethod,
          defaultMethodSaveStatus: 'idle',
        }),
      ),
      catchError(() => {
        ctx.patchState({ defaultMethodSaveStatus: 'error' });
        return of(null);
      }),
    );
  }

  @Action(ClearBillingState)
  clear(ctx: StateContext<BuilderBillingStateModel>) {
    ctx.setState(defaults);
  }
}
