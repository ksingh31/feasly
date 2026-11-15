/**
 * Admin global search service — pure logic with the store faked.
 * (Real-SQL coverage lives in admin-search.store.test.ts.)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildPatterns,
  createAdminSearchService,
  escapeLike,
  slugifyTerm,
} from '../src/services/admin-search.service';
import type { AdminSearchStore } from '../src/services/admin-search.store';
import { ROLE_PERMISSIONS, type Permission } from '../src/auth/permissions';

function fakeStore(): AdminSearchStore {
  return {
    searchLeads: vi.fn().mockResolvedValue([
      { id: 'l1', name: 'Ava', email: 'ava@example.com', addressKey: '123 FAKE ST NW' },
    ]),
    searchInvoices: vi.fn().mockResolvedValue([
      { id: 'i1', invoiceNumber: 'FEAS-2026-0105', tenantKey: 'elite-craft', status: 'paid' },
    ]),
    searchBuilders: vi.fn().mockResolvedValue([
      { id: 'b1', displayName: 'Elite Craft', businessName: 'Elite Craft', tenantKey: 'elite-craft' },
    ]),
    searchUsers: vi.fn().mockResolvedValue([
      { id: 'u1', name: 'Morgan', email: 'morgan@feasly.test' },
    ]),
  };
}

describe('escapeLike / slugifyTerm / buildPatterns', () => {
  it('escapes LIKE metacharacters', () => {
    expect(escapeLike('50%_off\\now')).toBe('50\\%\\_off\\\\now');
  });

  it('slugifies to lowercase dash-separated', () => {
    expect(slugifyTerm('  123 Fake St., NW ')).toBe('123-fake-st-nw');
    expect(slugifyTerm('%%%')).toBe('');
  });

  it('adds a slug pattern only when it differs from the raw term', () => {
    expect(buildPatterns('123 Fake St')).toEqual({ text: '%123 Fake St%', slug: '%123-fake-st%' });
    expect(buildPatterns('elite-craft')).toEqual({ text: '%elite-craft%', slug: null });
    expect(buildPatterns('%')).toEqual({ text: '%\\%%', slug: null });
  });
});

describe('createAdminSearchService', () => {
  it('maps every kind to typed hits in kind order for an admin', async () => {
    const store = fakeStore();
    const svc = createAdminSearchService({ store, config: { maxHitsPerKind: 7 } });
    const hits = await svc.search('e', ROLE_PERMISSIONS.admin);
    expect(hits).toEqual([
      { kind: 'lead', id: 'l1', label: 'Ava', sublabel: 'ava@example.com · 123 FAKE ST NW' },
      { kind: 'invoice', id: 'i1', label: 'FEAS-2026-0105', sublabel: 'elite-craft · paid' },
      // businessName === displayName → sublabel is just the slug.
      { kind: 'builder', id: 'b1', label: 'Elite Craft', sublabel: 'elite-craft' },
      { kind: 'user', id: 'u1', label: 'Morgan', sublabel: 'morgan@feasly.test' },
    ]);
    expect(store.searchLeads).toHaveBeenCalledWith({ text: '%e%', slug: null }, 7);
    expect(store.searchUsers).toHaveBeenCalledWith({ text: '%e%', slug: null }, 7);
  });

  it('never queries a kind the caller lacks the permission for', async () => {
    const store = fakeStore();
    const svc = createAdminSearchService({ store, config: { maxHitsPerKind: 5 } });
    const perms: Permission[] = ['leads:read'];
    const hits = await svc.search('e', perms);
    expect(hits.map((h) => h.kind)).toEqual(['lead']);
    expect(store.searchInvoices).not.toHaveBeenCalled();
    expect(store.searchBuilders).not.toHaveBeenCalled();
    expect(store.searchUsers).not.toHaveBeenCalled();
  });

  it('hides users from a viewer (no users:manage)', async () => {
    const store = fakeStore();
    const svc = createAdminSearchService({ store, config: { maxHitsPerKind: 5 } });
    const hits = await svc.search('e', ROLE_PERMISSIONS.viewer);
    expect(hits.map((h) => h.kind)).toEqual(['lead', 'invoice', 'builder']);
    expect(store.searchUsers).not.toHaveBeenCalled();
  });

  it('never leaks dollar figures or rates into hits', async () => {
    const store = fakeStore();
    const svc = createAdminSearchService({ store, config: { maxHitsPerKind: 5 } });
    const json = JSON.stringify(await svc.search('e', ROLE_PERMISSIONS.super_admin));
    expect(json).not.toMatch(/cents|commission|rate|\$/i);
  });
});
