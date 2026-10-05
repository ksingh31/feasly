/**
 * adminCan() specs (QA admin-console finding 8).
 *
 * The display-only permission signal must never throw: before the /me
 * probe resolves (or when the store is mocked in tests) the permissions
 * signal can emit null/undefined, and write UI must simply stay hidden.
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';
import { AdminAuthState } from './admin-auth.state';

describe('adminCan', () => {
  let store: Store;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideStore([AdminAuthState])],
    });
    store = TestBed.inject(Store);
  });

  function setPermissions(permissions: string[]): void {
    store.reset({
      adminAuth: {
        ...store.selectSnapshot((s) => s.adminAuth),
        permissions,
      },
    });
  }

  it('returns true when the permission is present, false when absent', () => {
    TestBed.runInInjectionContext(() => {
      setPermissions([ADMIN_PERMISSIONS.billingManage]);
      expect(adminCan(store, ADMIN_PERMISSIONS.billingManage)()).toBe(true);
      expect(adminCan(store, ADMIN_PERMISSIONS.leadsManage)()).toBe(false);
    });
  });

  it('is false (never throws) while permissions are unresolved', () => {
    TestBed.runInInjectionContext(() => {
      setPermissions([]);
      expect(adminCan(store, ADMIN_PERMISSIONS.billingManage)()).toBe(false);
    });
  });

  it('is false (never throws) when the signal emits null, like a mocked store', () => {
    const nullStore = {
      selectSignal: () => signal(null),
    } as unknown as Store;
    TestBed.runInInjectionContext(() => {
      expect(() =>
        adminCan(nullStore, ADMIN_PERMISSIONS.billingManage)(),
      ).not.toThrow();
      expect(adminCan(nullStore, ADMIN_PERMISSIONS.billingManage)()).toBe(
        false,
      );
    });
  });
});
