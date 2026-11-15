/**
 * Admin sidebar model (#503, docs/design/portal-ui-kit.md §4).
 *
 * Structure only — ids, paths, permission gates, badge sources. Labels come
 * from ConfigService (`copy.admin.shell`), keyed by these ids. Every routed
 * admin section must appear here (admin-nav.spec.ts asserts it against
 * app.routes.ts) so no admin page is reachable only by URL.
 *
 * Quarantine and Webhooks from the design have no route yet; they join
 * their groups when those pages ship.
 */
import { ADMIN_PERMISSIONS } from './admin-permissions';

export type AdminNavGroupId = 'pipeline' | 'partners' | 'money' | 'system';

export type AdminNavItemId =
  | 'leads'
  | 'estimates'
  | 'builders'
  | 'users'
  | 'apiKeys'
  | 'billing'
  | 'invoices'
  | 'disputes'
  | 'calibration'
  | 'sheets'
  | 'funnels';

/** Queue badge sources the shell knows how to count. */
export type AdminNavBadge = 'disputes';

export interface AdminNavItemDef {
  readonly id: AdminNavItemId;
  /** Absolute router path. */
  readonly path: string;
  /**
   * Exact-match active state. Needed where a sibling section lives under
   * this path (Billing overview vs. /admin/billing/invoices).
   */
  readonly exact?: boolean;
  /** Display-only permission gate (backend stays authoritative). */
  readonly permission?: string;
  readonly badge?: AdminNavBadge;
}

export interface AdminNavGroupDef {
  readonly id: AdminNavGroupId;
  readonly items: readonly AdminNavItemDef[];
}

export const ADMIN_NAV: readonly AdminNavGroupDef[] = [
  {
    id: 'pipeline',
    items: [
      { id: 'leads', path: '/admin/leads' },
      { id: 'estimates', path: '/admin/estimates' },
    ],
  },
  {
    id: 'partners',
    items: [
      { id: 'builders', path: '/admin/builders' },
      { id: 'users', path: '/admin/users' },
      { id: 'apiKeys', path: '/admin/api-keys', permission: ADMIN_PERMISSIONS.apiKeysManage },
    ],
  },
  {
    id: 'money',
    items: [
      { id: 'billing', path: '/admin/billing', exact: true },
      { id: 'invoices', path: '/admin/billing/invoices' },
      { id: 'disputes', path: '/admin/disputes', badge: 'disputes' },
    ],
  },
  {
    id: 'system',
    items: [
      { id: 'calibration', path: '/admin/calibration' },
      { id: 'sheets', path: '/admin/ops/sheets' },
      { id: 'funnels', path: '/admin/funnels' },
    ],
  },
];

/**
 * The nav item (and its group) that owns `url`: the longest item path that
 * is the url or a parent of it. Query string and fragment are ignored.
 * Returns null for shell pages outside the nav (e.g. /admin/error).
 */
export function findAdminNavItem(
  url: string,
): { group: AdminNavGroupDef; item: AdminNavItemDef } | null {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, '');
  let best: { group: AdminNavGroupDef; item: AdminNavItemDef } | null = null;
  for (const group of ADMIN_NAV) {
    for (const item of group.items) {
      const owns = path === item.path || path.startsWith(`${item.path}/`);
      if (owns && (!best || item.path.length > best.item.path.length)) {
        best = { group, item };
      }
    }
  }
  return best;
}
