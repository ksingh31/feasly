import { Injectable, makeEnvironmentProviders } from '@angular/core';
import type { EnvironmentProviders } from '@angular/core';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import {
  ClearBannerState,
  DismissAllBanners,
  DismissBanner,
  PruneBannerState,
  SetBannersCollapsed,
  ToggleBannerOpen,
} from './due-invoice-banners.actions';

export interface DueInvoiceBannersStateModel {
  /** Invoice ids whose banner the builder dismissed. Persists (storage plugin). */
  dismissedIds: readonly string[];
  /** Invoice ids whose banner detail body is expanded. Persists (storage plugin). */
  openIds: readonly string[];
  /** Whether the stack is folded into the slim summary bar. Persists. */
  stackCollapsed: boolean;
}

const defaults: DueInvoiceBannersStateModel = {
  dismissedIds: [],
  openIds: [],
  stackCollapsed: false,
};

/**
 * Due-invoice banner UI state.
 *
 * Replaces the former root-provided DueInvoiceBannersService (ad-hoc
 * signals): Karan's standing standard is that ALL client state lives in
 * NGXS, with @ngxs/storage-plugin for persistence instead of hand-rolled
 * localStorage. Dismissal now survives a reload — the old service
 * deliberately wiped it.
 *
 * Memory-vs-persisted split: the whole model persists (invoice ids are
 * opaque UUIDs, no PII). Stale ids are pruned on every successful
 * actionable-invoice load (PruneBannerState), so a paid invoice's
 * dismissal never lingers.
 */
@State<DueInvoiceBannersStateModel>({
  name: 'dueInvoiceBanners',
  defaults,
})
@Injectable()
export class DueInvoiceBannersState {
  @Selector()
  static dismissedIds(state: DueInvoiceBannersStateModel): readonly string[] {
    return state?.dismissedIds ?? [];
  }

  @Selector()
  static openIds(state: DueInvoiceBannersStateModel): readonly string[] {
    return state?.openIds ?? [];
  }

  @Selector()
  static stackCollapsed(state: DueInvoiceBannersStateModel): boolean {
    return state?.stackCollapsed ?? false;
  }

  /** Set form of dismissedIds for O(1) template lookups. */
  @Selector()
  static dismissedSet(state: DueInvoiceBannersStateModel): ReadonlySet<string> {
    return new Set(state?.dismissedIds ?? []);
  }

  @Action(DismissBanner)
  dismiss(ctx: StateContext<DueInvoiceBannersStateModel>, action: DismissBanner) {
    const state = ctx.getState();
    if (state.dismissedIds.includes(action.id)) {
      return;
    }
    ctx.patchState({
      dismissedIds: [...state.dismissedIds, action.id],
      openIds: state.openIds.filter((id) => id !== action.id),
    });
  }

  @Action(DismissAllBanners)
  dismissAll(
    ctx: StateContext<DueInvoiceBannersStateModel>,
    action: DismissAllBanners,
  ) {
    const state = ctx.getState();
    const dismissed = new Set(state.dismissedIds);
    for (const id of action.ids) {
      dismissed.add(id);
    }
    const dismissedIds = [...dismissed];
    const removed = new Set(action.ids);
    ctx.patchState({
      dismissedIds,
      openIds: state.openIds.filter((id) => !removed.has(id)),
    });
  }

  @Action(ToggleBannerOpen)
  toggleOpen(
    ctx: StateContext<DueInvoiceBannersStateModel>,
    action: ToggleBannerOpen,
  ) {
    const state = ctx.getState();
    ctx.patchState({
      openIds: state.openIds.includes(action.id)
        ? state.openIds.filter((id) => id !== action.id)
        : [...state.openIds, action.id],
    });
  }

  @Action(SetBannersCollapsed)
  setCollapsed(
    ctx: StateContext<DueInvoiceBannersStateModel>,
    action: SetBannersCollapsed,
  ) {
    ctx.patchState({ stackCollapsed: action.collapsed });
  }

  @Action(PruneBannerState)
  prune(ctx: StateContext<DueInvoiceBannersStateModel>, action: PruneBannerState) {
    const actionable = new Set(action.actionableIds);
    const state = ctx.getState();
    const dismissedIds = state.dismissedIds.filter((id) => actionable.has(id));
    const openIds = state.openIds.filter((id) => actionable.has(id));
    if (
      dismissedIds.length !== state.dismissedIds.length ||
      openIds.length !== state.openIds.length
    ) {
      ctx.patchState({ dismissedIds, openIds });
    }
  }

  @Action(ClearBannerState)
  clear(ctx: StateContext<DueInvoiceBannersStateModel>) {
    ctx.setState(defaults);
  }
}

/**
 * Lazy provider for the dashboard route (via lazyProvider in
 * app.routes.ts): the banners state stays out of the initial bundle,
 * mirroring builderInvoicesStateProvider. The storage plugin rehydrates
 * it on the lazy UpdateState — dismissal survives reloads and
 * dashboard ↔ invoices navigation.
 */
export const dueInvoiceBannersStateProvider: EnvironmentProviders =
  makeEnvironmentProviders([provideStates([DueInvoiceBannersState])]);
