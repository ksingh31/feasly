import { inject, Injectable } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import { catchError, of, tap } from 'rxjs';
import type { BillingHealthResponse } from '@feasly/contracts';
import { AdminBillingApiService } from './admin-billing-api.service';
import { LoadBillingHealth } from './billing-health.actions';

/** Loading lifecycle for the billing-health dashboard. */
export type BillingHealthLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface BillingHealthStateModel {
  /** The latest dashboard payload, or null before the first load. */
  health: BillingHealthResponse | null;
  /** Load lifecycle. */
  loadStatus: BillingHealthLoadStatus;
  /** Load failure flag. The raw error never reaches the UI. */
  error: string | null;
}

const defaults: BillingHealthStateModel = {
  health: null,
  loadStatus: 'idle',
  error: null,
};

/**
 * Billing-health dashboard state (billing/03 follow-on — /admin/billing).
 *
 * Single source of truth for the `/admin/billing` page. The action handler
 * RETURNS its API observable (never a bare `.subscribe()`): NGXS then owns
 * the subscription, so a newer `LoadBillingHealth` cancels an in-flight
 * load and no stale response can overwrite a newer one.
 *
 * Memory-only: never added to the storage plugin (billing health goes
 * stale — each visit reloads).
 */
@State<BillingHealthStateModel>({
  name: 'billingHealth',
  defaults,
})
@Injectable()
export class BillingHealthState {
  private readonly api = inject(AdminBillingApiService);

  @Selector()
  static health(
    state: BillingHealthStateModel,
  ): BillingHealthResponse | null {
    return state.health;
  }

  @Selector()
  static loadStatus(
    state: BillingHealthStateModel,
  ): BillingHealthLoadStatus {
    return state.loadStatus;
  }

  @Selector()
  static error(state: BillingHealthStateModel): string | null {
    return state.error;
  }

  /** True when dunning needs attention (any failed-charge invoice). */
  @Selector()
  static hasDunning(state: BillingHealthStateModel): boolean {
    return (state.health?.dunning.length ?? 0) > 0;
  }

  /** True when the webhook receiver looks unhealthy in the last 24h. */
  @Selector()
  static hasWebhookIssues(state: BillingHealthStateModel): boolean {
    const webhooks = state.health?.webhooks;
    if (!webhooks) return false;
    return webhooks.unhandled24h > 0 || webhooks.modelMismatch24h > 0;
  }

  @Action(LoadBillingHealth)
  loadBillingHealth(ctx: StateContext<BillingHealthStateModel>) {
    ctx.patchState({ loadStatus: 'loading', error: null });
    return this.api.getBillingHealth().pipe(
      tap((health) =>
        ctx.patchState({ health, loadStatus: 'ready', error: null }),
      ),
      catchError(() => {
        ctx.patchState({
          loadStatus: 'error',
          error: 'Could not load billing health. Try again.',
        });
        return of(null);
      }),
    );
  }
}
