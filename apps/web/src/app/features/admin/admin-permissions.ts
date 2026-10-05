import { computed, type Signal } from '@angular/core';
import { Store } from '@ngxs/store';
import { AdminAuthState } from './admin-auth.state';

/**
 * Backend permission strings (see `apps/api/src/auth/permissions.ts` and
 * the route registry). The frontend checks these for display-only gating —
 * hiding write UI from sessions that lack the permission. The backend is
 * authoritative: every write endpoint re-checks and 403s without it.
 *
 * Legacy (pre-user-model) magic-link admin sessions resolve to the full
 * `admin` permission set server-side, so gating on these strings never
 * hides UI from a legacy session that could previously write.
 */
export const ADMIN_PERMISSIONS = {
  /** Approve/discard quarantine, update lead status, post lead notes, assign builders. */
  leadsManage: 'leads:manage',
  /** Assign a lead to a builder. */
  leadsAssign: 'leads:assign',
  /** Create/manage builders. */
  buildersManage: 'builders:manage',
  /** Retry charges, create/mark-paid/rate-override invoices, resolve disputes. */
  billingManage: 'billing:manage',
  /** Issue/revoke MCP API keys. */
  apiKeysManage: 'api_keys:manage',
  /** Invite/edit/deactivate staff users. */
  usersManage: 'users:manage',
} as const;

/**
 * Display-only permission signal for admin components.
 *
 * Call from a component field initializer (injection context):
 *
 * ```ts
 * protected readonly canManageBilling = adminCan(this.store, ADMIN_PERMISSIONS.billingManage);
 * ```
 *
 * The returned signal is false until the /me probe resolves permissions —
 * write UI stays hidden rather than flashing.
 */
export function adminCan(store: Store, permission: string): Signal<boolean> {
  const permissions = store.selectSignal(AdminAuthState.permissions);
  // Null-safe: the selector can emit null/undefined before the /me probe
  // resolves (and unit tests may mock the store with signal(null)).
  return computed(() => permissions()?.includes(permission) ?? false);
}
