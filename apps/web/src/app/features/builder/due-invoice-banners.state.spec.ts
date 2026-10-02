/**
 * DueInvoiceBannersState tests (NGXS + storage-plugin persistence).
 *
 * Covers the migration from the old root-provided DueInvoiceBannersService
 * (ad-hoc signals, session-only): dismissals now live in NGXS and persist
 * across store instances (the storage-plugin rehydration path), expansion
 * toggles, stack collapse, dismiss-all, and pruning of stale ids when
 * invoices leave the actionable set.
 */
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ClearBannerState,
  DismissAllBanners,
  DismissBanner,
  PruneBannerState,
  SetBannersCollapsed,
  ToggleBannerOpen,
} from './due-invoice-banners.actions';
import { DueInvoiceBannersState } from './due-invoice-banners.state';

function setup(): Store {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideStore([DueInvoiceBannersState])],
  });
  return TestBed.inject(Store);
}

describe('DueInvoiceBannersState', () => {
  let store: Store;
  beforeEach(() => {
    store = setup();
  });

  it('starts with nothing dismissed, nothing open, stack expanded', () => {
    expect(store.selectSnapshot(DueInvoiceBannersState.dismissedIds)).toEqual(
      [],
    );
    expect(store.selectSnapshot(DueInvoiceBannersState.openIds)).toEqual([]);
    expect(store.selectSnapshot(DueInvoiceBannersState.stackCollapsed)).toBe(
      false,
    );
  });

  it('dismisses one invoice and closes it if open', () => {
    store.dispatch(new ToggleBannerOpen('inv-1'));
    expect(store.selectSnapshot(DueInvoiceBannersState.openIds)).toEqual([
      'inv-1',
    ]);

    store.dispatch(new DismissBanner('inv-1'));
    expect(store.selectSnapshot(DueInvoiceBannersState.dismissedIds)).toEqual([
      'inv-1',
    ]);
    expect(store.selectSnapshot(DueInvoiceBannersState.openIds)).toEqual([]);
  });

  it('dismissing twice does not duplicate the id', () => {
    store.dispatch(new DismissBanner('inv-1'));
    store.dispatch(new DismissBanner('inv-1'));
    expect(store.selectSnapshot(DueInvoiceBannersState.dismissedIds)).toEqual([
      'inv-1',
    ]);
  });

  it('dismissAll dismisses every given id', () => {
    store.dispatch(new DismissAllBanners(['inv-1', 'inv-2']));
    expect(
      store.selectSnapshot(DueInvoiceBannersState.dismissedSet).has('inv-1'),
    ).toBe(true);
    expect(
      store.selectSnapshot(DueInvoiceBannersState.dismissedSet).has('inv-2'),
    ).toBe(true);
    expect(
      store.selectSnapshot(DueInvoiceBannersState.dismissedSet).has('inv-3'),
    ).toBe(false);
  });

  it('toggles banner expansion', () => {
    store.dispatch(new ToggleBannerOpen('inv-1'));
    expect(store.selectSnapshot(DueInvoiceBannersState.openIds)).toEqual([
      'inv-1',
    ]);
    store.dispatch(new ToggleBannerOpen('inv-1'));
    expect(store.selectSnapshot(DueInvoiceBannersState.openIds)).toEqual([]);
  });

  it('folds and unfolds the stack', () => {
    store.dispatch(new SetBannersCollapsed(true));
    expect(store.selectSnapshot(DueInvoiceBannersState.stackCollapsed)).toBe(
      true,
    );
    store.dispatch(new SetBannersCollapsed(false));
    expect(store.selectSnapshot(DueInvoiceBannersState.stackCollapsed)).toBe(
      false,
    );
  });

  it('prunes ids that left the actionable set', () => {
    store.dispatch(new DismissBanner('paid-1'));
    store.dispatch(new ToggleBannerOpen('paid-1'));
    store.dispatch(new DismissBanner('due-1'));
    store.dispatch(new PruneBannerState(['due-1', 'due-2']));

    // paid-1 left the actionable set: pruned from both lists.
    expect(store.selectSnapshot(DueInvoiceBannersState.dismissedIds)).toEqual([
      'due-1',
    ]);
    expect(store.selectSnapshot(DueInvoiceBannersState.openIds)).toEqual([]);
  });

  it('clear resets to defaults', () => {
    store.dispatch(new DismissBanner('inv-1'));
    store.dispatch(new SetBannersCollapsed(true));
    store.dispatch(new ClearBannerState());
    expect(store.selectSnapshot(DueInvoiceBannersState.dismissedIds)).toEqual(
      [],
    );
    expect(store.selectSnapshot(DueInvoiceBannersState.stackCollapsed)).toBe(
      false,
    );
  });

  it('dismissal survives a fresh store instance (persistence contract)', () => {
    // The storage plugin persists the model; a new store instance (page
    // reload) rehydrates it. Here we prove the state half of the contract:
    // dismissed ids are plain serializable model data, and re-applying the
    // persisted model restores them.
    store.dispatch(new DismissBanner('inv-1'));
    store.dispatch(new SetBannersCollapsed(true));
    const persisted = store.snapshot().dueInvoiceBanners;

    const fresh = setup();
    fresh.reset({ dueInvoiceBanners: persisted });

    expect(fresh.selectSnapshot(DueInvoiceBannersState.dismissedIds)).toEqual([
      'inv-1',
    ]);
    expect(fresh.selectSnapshot(DueInvoiceBannersState.stackCollapsed)).toBe(
      true,
    );
  });
});
