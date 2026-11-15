/**
 * Admin global search contracts (admin redesign — ⌘K command palette).
 *
 * Backend route:
 * - `GET /api/v1/admin/search?q=` — one query across leads (name, email,
 *   address), commission invoices (invoice number), builders (business
 *   name, display name, slug) and users (name, email). Feasly staff only
 *   (`leads:read`); builder roles get 403. Each hit kind is further gated
 *   by the caller's own permissions — invoices need `billing:read`,
 *   builders `builders:read`, users `users:manage` — so a viewer never
 *   sees a kind they could not open.
 *
 * Hits carry display labels and IDs only — enough for the palette to
 * render a row and navigate. Never dollar figures, rates, or credentials.
 */

/** What a hit points at. The UI maps each kind to its detail route. */
export type AdminSearchHitKind = 'lead' | 'invoice' | 'builder' | 'user';

/** One typed search hit. */
export interface AdminSearchHit {
  readonly kind: AdminSearchHitKind;
  /** The entity's UUID — the detail route parameter. */
  readonly id: string;
  /** Primary display line (lead name, invoice number, builder name, user name). */
  readonly label: string;
  /** Secondary display line (email, address, slug, …); null when there is none. */
  readonly sublabel: string | null;
}

/** `GET /api/v1/admin/search` response. */
export interface AdminSearchResponse {
  /** The trimmed query the server searched for. */
  readonly query: string;
  /** Hits grouped in kind order: leads, invoices, builders, users. */
  readonly hits: readonly AdminSearchHit[];
}
