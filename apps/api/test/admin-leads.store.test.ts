import { describe, expect, it } from 'vitest';
import { pipelineCountFilters } from '../src/services/admin-leads.store';
import type { AdminLeadFilters } from '../src/services/admin-leads.store';

/**
 * FE-9: the pipeline totals row must count across the full filtered set
 * with every active filter EXCEPT `status` applied, so the totals stay
 * stable while the admin switches status filters.
 */
describe('pipelineCountFilters', () => {
  it('drops the status filter while keeping every other filter', () => {
    const filters: AdminLeadFilters = {
      status: 'won',
      minScore: 50,
      maxScore: 90,
      source: 'web',
      projectType: 'new_build',
      tenantKey: 'feasly',
      search: 'ava',
      createdAfter: new Date('2026-09-01T00:00:00Z'),
      createdBefore: new Date('2026-10-01T00:00:00Z'),
      includeQuarantined: true,
      includeSandbox: false,
    };

    const countsFilters = pipelineCountFilters(filters);

    expect(countsFilters).not.toHaveProperty('status');
    expect(countsFilters).toEqual({
      minScore: 50,
      maxScore: 90,
      source: 'web',
      projectType: 'new_build',
      tenantKey: 'feasly',
      search: 'ava',
      createdAfter: new Date('2026-09-01T00:00:00Z'),
      createdBefore: new Date('2026-10-01T00:00:00Z'),
      includeQuarantined: true,
      includeSandbox: false,
    });
  });

  it('keeps quarantine/sandbox exclusions in the counts', () => {
    const countsFilters = pipelineCountFilters({
      status: 'new',
      includeQuarantined: false,
      includeSandbox: false,
    });
    expect(countsFilters.includeQuarantined).toBe(false);
    expect(countsFilters.includeSandbox).toBe(false);
  });

  it('keeps quarantinedOnly in the counts so the quarantine tab totals match', () => {
    const countsFilters = pipelineCountFilters({
      status: 'new',
      quarantinedOnly: true,
    });
    expect(countsFilters.quarantinedOnly).toBe(true);
    expect(countsFilters).not.toHaveProperty('status');
  });

  it('keeps the builderId assignment filter in the counts', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(
      pipelineCountFilters({ status: 'new', builderId: uuid }).builderId,
    ).toBe(uuid);
    expect(
      pipelineCountFilters({ status: 'new', builderId: null }).builderId,
    ).toBeNull();
  });

  it('does not mutate the original filters', () => {
    const filters: AdminLeadFilters = { status: 'won', minScore: 50 };
    pipelineCountFilters(filters);
    expect(filters).toEqual({ status: 'won', minScore: 50 });
  });

  it('returns an equal object when no status filter is set', () => {
    const filters: AdminLeadFilters = { minScore: 50 };
    expect(pipelineCountFilters(filters)).toEqual({ minScore: 50 });
  });
});
