import { describe, expect, it, vi } from 'vitest';
import { adminEntityTarget, openAdminEntity } from './admin-entity-routes';

describe('adminEntityTarget (#538)', () => {
  it('maps each record kind to its page', () => {
    expect(adminEntityTarget('lead', 'l1')).toEqual({ commands: ['/admin/leads'], queryParams: { open: 'l1' } });
    expect(adminEntityTarget('invoice', 'i1')).toEqual({ commands: ['/admin/billing/invoices'], queryParams: { open: 'i1' } });
    expect(adminEntityTarget('builder', 'b1')).toEqual({ commands: ['/admin/builders'], queryParams: { open: 'b1' } });
    expect(adminEntityTarget('user', 'u1')).toEqual({ commands: ['/admin/users'], queryParams: { open: 'u1' } });
  });

  it('openAdminEntity navigates there', () => {
    const router = { navigate: vi.fn().mockResolvedValue(true) };
    openAdminEntity(router, 'lead', 'l1');
    expect(router.navigate).toHaveBeenCalledWith(['/admin/leads'], { queryParams: { open: 'l1' } });
  });
});
