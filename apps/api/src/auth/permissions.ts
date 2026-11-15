/**
 * Permission model (auth/04).
 *
 * Permissions are strings; a checked-in `ROLE_PERMISSIONS` map (code, not
 * DB) defines what each role holds. Changing it is a deploy — deliberate,
 * because security semantics must never change at runtime via data.
 *
 * Effective permissions = staff-role permissions ∪ union of membership-role
 * permissions. A signed-in user with no staff role and no memberships gets
 * the empty set: they see a "no access" state, never an error dump.
 *
 * Roles (fixed set):
 * - Feasly staff (`users.staff_role`):
 *   - `super_admin` — everything, incl. managing other super_admins and
 *     view-as (Karan; protected row).
 *   - `admin` — everything except managing super_admins.
 *   - `viewer` — read-only (e.g. accountant seeing invoices).
 * - Builder org (`builder_memberships.role`):
 *   - `builder_admin` — their builder's leads, invoices, disputes + manage
 *     their org's users + initiate view-as (regular-user targets only).
 *   - `builder_member` — their builder's leads (read + status updates), no
 *     user management.
 *
 * Pure module: no I/O, no env, no db. Safe to import from middleware,
 * services, and tests.
 */
import type { BuilderRole, StaffRole } from '../services/user.service';

export const PERMISSIONS = [
  // Admin: leads
  'leads:read',
  'leads:manage',
  'leads:assign',
  // Admin: builders table
  'builders:read',
  'builders:manage',
  // Admin: billing + disputes
  'billing:read',
  'billing:manage',
  // Admin: platform
  'api_keys:manage',
  'calibration:read',
  'analytics:read',
  'estimates:read',
  'usage:read',
  'ops:manage',
  // Admin: user management (AUTH-03 builds on these)
  'users:manage',
  'super_admins:manage',
  // Admin: view-as (auth/04)
  'view_as',
  // Admin: audit trail + accountant exports (#728)
  'audit:read',
  'finance:export',
  // Builder org
  'builder:leads:read',
  'builder:leads:manage',
  'builder:billing',
  'builder:users:manage',
  // Builder org activity history (#728). Every member reads their own
  // activity; `builder:activity:team` widens it to the whole org (owner
  // decision 2026-11-15: builder owner + admins see their team).
  'builder:activity:read',
  'builder:activity:team',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type AnyRole = StaffRole | BuilderRole;

/**
 * The checked-in role → permissions map. Keep in sync with the story doc
 * (`plan/stories/auth/04-permission-model.md`); the matrix test asserts
 * every role × every registry route against this map.
 */
export const ROLE_PERMISSIONS: Record<AnyRole, readonly Permission[]> = {
  super_admin: [
    'leads:read',
    'leads:manage',
    'leads:assign',
    'builders:read',
    'builders:manage',
    'billing:read',
    'billing:manage',
    'api_keys:manage',
    'calibration:read',
    'analytics:read',
    'estimates:read',
    'usage:read',
    'ops:manage',
    'users:manage',
    'super_admins:manage',
    'view_as',
    'audit:read',
    'finance:export',
    'builder:leads:read',
    'builder:leads:manage',
    'builder:billing',
    'builder:users:manage',
    'builder:activity:read',
    'builder:activity:team',
  ],
  admin: [
    'leads:read',
    'leads:manage',
    'leads:assign',
    'builders:read',
    'builders:manage',
    'billing:read',
    'billing:manage',
    'api_keys:manage',
    'calibration:read',
    'analytics:read',
    'estimates:read',
    'usage:read',
    'ops:manage',
    'users:manage',
    'view_as',
    'audit:read',
    'finance:export',
    'builder:leads:read',
    'builder:leads:manage',
    'builder:billing',
    'builder:users:manage',
    'builder:activity:read',
    'builder:activity:team',
  ],
  viewer: [
    'leads:read',
    'builders:read',
    'billing:read',
    'calibration:read',
    'analytics:read',
    'estimates:read',
    // auth/04: viewer is read-only — every read permission, no writes.
    'usage:read',
    // #728: the accountant persona — reads the audit trail and exports
    // invoices/finance summaries (both read-only).
    'audit:read',
    'finance:export',
  ],
  builder_admin: [
    'builder:leads:read',
    'builder:leads:manage',
    'builder:billing',
    'builder:users:manage',
    // 2026-09-30 (Karan): builder-side admins may initiate view-as (regular
    // users only as targets — enforced in view-as.service.ts). viewer and
    // builder_member never hold this.
    'view_as',
    // #728 (owner 2026-11-15): builder owner/admins see the team's activity.
    'builder:activity:read',
    'builder:activity:team',
  ],
  // #728: members see only their own activity (no `builder:activity:team`).
  builder_member: [
    'builder:leads:read',
    'builder:leads:manage',
    'builder:activity:read',
  ],
};

/**
 * Effective permissions for a user: staff-role perms ∪ union of
 * membership-role perms. No staff role + no memberships → empty.
 */
export function effectivePermissions(
  staffRole: StaffRole | null,
  membershipRoles: readonly BuilderRole[],
): Permission[] {
  const out = new Set<Permission>();
  if (staffRole) {
    for (const p of ROLE_PERMISSIONS[staffRole]) out.add(p);
  }
  for (const role of membershipRoles) {
    for (const p of ROLE_PERMISSIONS[role]) out.add(p);
  }
  return [...out];
}

export function hasPermission(
  permissions: readonly Permission[],
  permission: Permission,
): boolean {
  return permissions.includes(permission);
}

/** Type-guard for permission strings coming from untyped sources. */
export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
