/**
 * Permission model tests (auth/04).
 *
 * The role/permission map is checked in and frozen here: any change to who
 * can do what must update these expectations deliberately, never by
 * accident.
 */
import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  effectivePermissions,
  hasPermission,
  isPermission,
  type AnyRole,
  type Permission,
} from '../src/auth/permissions';

const ALL_ROLES: readonly AnyRole[] = [
  'super_admin',
  'admin',
  'viewer',
  'builder_admin',
  'builder_member',
];

describe('permission model (auth/04)', () => {
  it('covers exactly the five checked-in roles', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(
      [...ALL_ROLES].sort(),
    );
  });

  it('every role permission is a known permission string', () => {
    const known = new Set<Permission>(PERMISSIONS);
    for (const role of ALL_ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) {
        expect(known.has(p), `${role} has unknown permission ${p}`).toBe(true);
      }
    }
  });

  it('no role lists a permission twice', () => {
    for (const role of ALL_ROLES) {
      const perms = ROLE_PERMISSIONS[role];
      expect(new Set(perms).size, `${role} duplicates`).toBe(perms.length);
    }
  });

  it('super_admin holds every permission', () => {
    expect(new Set(ROLE_PERMISSIONS.super_admin)).toEqual(
      new Set(PERMISSIONS),
    );
  });

  it('only super_admin can manage super_admins', () => {
    for (const role of ALL_ROLES) {
      const expected = role === 'super_admin';
      expect(
        hasPermission(ROLE_PERMISSIONS[role], 'super_admins:manage'),
        role,
      ).toBe(expected);
    }
  });

  it('only super_admin, admin, and builder_admin can view-as', () => {
    for (const role of ALL_ROLES) {
      const expected =
        role === 'super_admin' || role === 'admin' || role === 'builder_admin';
      expect(hasPermission(ROLE_PERMISSIONS[role], 'view_as'), role).toBe(
        expected,
      );
    }
  });

  it('viewer is read-only on the admin surface', () => {
    const viewer = ROLE_PERMISSIONS.viewer;
    expect(hasPermission(viewer, 'leads:read')).toBe(true);
    expect(hasPermission(viewer, 'builders:read')).toBe(true);
    expect(hasPermission(viewer, 'billing:read')).toBe(true);
    expect(hasPermission(viewer, 'analytics:read')).toBe(true);
    expect(hasPermission(viewer, 'calibration:read')).toBe(true);
    expect(hasPermission(viewer, 'estimates:read')).toBe(true);
    // auth/04: viewer is read-only per the story — usage:read is a read.
    expect(hasPermission(viewer, 'usage:read')).toBe(true);
    for (const p of PERMISSIONS) {
      if (p.endsWith(':manage') || p === 'leads:assign' || p === 'view_as') {
        expect(hasPermission(viewer, p), `viewer must not have ${p}`).toBe(
          false,
        );
      }
    }
  });

  it('builder roles never touch the admin surface (except builder_admin view-as)', () => {
    for (const role of ['builder_admin', 'builder_member'] as const) {
      const perms = ROLE_PERMISSIONS[role];
      for (const p of PERMISSIONS) {
        if (p.startsWith('builder:')) continue;
        // 2026-09-30 (Karan): builder-side admins may initiate view-as —
        // targets are restricted to regular users in view-as.service.ts.
        if (role === 'builder_admin' && p === 'view_as') {
          expect(hasPermission(perms, p)).toBe(true);
          continue;
        }
        expect(hasPermission(perms, p), `${role} must not have ${p}`).toBe(
          false,
        );
      }
    }
  });

  it('builder_member cannot manage builder users or billing', () => {
    const member = ROLE_PERMISSIONS.builder_member;
    expect(hasPermission(member, 'builder:leads:read')).toBe(true);
    expect(hasPermission(member, 'builder:leads:manage')).toBe(true);
    expect(hasPermission(member, 'builder:users:manage')).toBe(false);
    expect(hasPermission(member, 'builder:billing')).toBe(false);
  });

  it('builder_admin can manage builder users and billing', () => {
    const admin = ROLE_PERMISSIONS.builder_admin;
    expect(hasPermission(admin, 'builder:users:manage')).toBe(true);
    expect(hasPermission(admin, 'builder:billing')).toBe(true);
  });
});

describe('effectivePermissions', () => {
  it('unions staff-role and membership-role permissions', () => {
    const perms = effectivePermissions('viewer', ['builder_member']);
    expect(hasPermission(perms, 'leads:read')).toBe(true); // staff
    expect(hasPermission(perms, 'builder:leads:manage')).toBe(true); // membership
    expect(hasPermission(perms, 'leads:manage')).toBe(false); // neither
  });

  it('unions multiple memberships', () => {
    const perms = effectivePermissions(null, [
      'builder_member',
      'builder_admin',
    ]);
    expect(hasPermission(perms, 'builder:billing')).toBe(true);
    expect(hasPermission(perms, 'builder:users:manage')).toBe(true);
  });

  it('valid user with no roles and no memberships gets empty access', () => {
    expect(effectivePermissions(null, [])).toEqual([]);
  });

  it('staff-only user gets exactly the staff permissions', () => {
    expect(new Set(effectivePermissions('admin', []))).toEqual(
      new Set(ROLE_PERMISSIONS.admin),
    );
  });

  it('membership-only user gets exactly the membership permissions', () => {
    expect(new Set(effectivePermissions(null, ['builder_admin']))).toEqual(
      new Set(ROLE_PERMISSIONS.builder_admin),
    );
  });
});

describe('isPermission', () => {
  it('accepts known permissions and rejects the rest', () => {
    expect(isPermission('leads:read')).toBe(true);
    expect(isPermission('view_as')).toBe(true);
    expect(isPermission('not:a-permission')).toBe(false);
    expect(isPermission('')).toBe(false);
  });
});
