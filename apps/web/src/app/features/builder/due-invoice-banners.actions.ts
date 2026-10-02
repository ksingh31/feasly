/**
 * Due-invoice banner UI actions.
 *
 * All banner dismissal/expansion/collapse state lives in
 * DueInvoiceBannersState (NGXS + storage-plugin persistence) — never in
 * an ad-hoc service. Dismissing a banner never touches invoice state and
 * never calls the backend; a banner disappears for good only when its
 * invoice leaves the actionable set (paid, voided, …), which is purely
 * data-driven.
 */

/** Dismiss one banner (× on the banner). Persists across reloads. */
export class DismissBanner {
  static readonly type = '[DueInvoiceBanners] Dismiss banner';
  constructor(public readonly id: string) {}
}

/** Dismiss every currently visible banner (× on the summary bar). */
export class DismissAllBanners {
  static readonly type = '[DueInvoiceBanners] Dismiss all banners';
  constructor(public readonly ids: readonly string[]) {}
}

/** Expand or collapse one banner's detail body. */
export class ToggleBannerOpen {
  static readonly type = '[DueInvoiceBanners] Toggle banner open';
  constructor(public readonly id: string) {}
}

/** Fold the whole stack into the slim summary bar, or unfold it. */
export class SetBannersCollapsed {
  static readonly type = '[DueInvoiceBanners] Set stack collapsed';
  constructor(public readonly collapsed: boolean) {}
}

/**
 * Drop dismissal/expansion ids that are no longer in the actionable set
 * (their invoices were paid, voided, …). Dispatched after each successful
 * actionable-invoice load so persisted dismissal state can't grow
 * unboundedly.
 */
export class PruneBannerState {
  static readonly type = '[DueInvoiceBanners] Prune stale ids';
  constructor(public readonly actionableIds: readonly string[]) {}
}

/** Resets banner UI state (after logout). */
export class ClearBannerState {
  static readonly type = '[DueInvoiceBanners] Clear';
}
