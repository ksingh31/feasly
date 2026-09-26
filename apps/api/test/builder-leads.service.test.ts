/**
 * Unit tests for the builder-leads service (embed/09).
 *
 * Tenant isolation is the critical property:
 * - listLeads returns ONLY the builder's tenant leads.
 * - updateStatus on another tenant's lead throws 403.
 * - Every real status transition appends lead_status_history.
 *
 * Fakes in-memory: no DB, no network. Tests run under vitest.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createBuilderLeadsService,
  type BuilderLeadsServiceDeps,
} from '../src/services/builder-leads.service';
import type { LeadStore } from '../src/services/lead.store';
import type { AdminAuditStore } from '../src/services/admin-audit.store';

function makeLead(overrides?: {
  readonly id?: string;
  readonly tenantKey?: string;
  readonly status?: string;
}) {
  return {
    id: overrides?.id ?? 'lead-1',
    estimateId: 'est-1',
    tenantKey: overrides?.tenantKey ?? 'elite-craft',
    addressKey: '123 Main St',
    email: 'homeowner@example.com',
    name: 'Jane Doe',
    phone: null,
    timeline: '3-6 months',
    leadScore: 75,
    status: overrides?.status ?? 'new',
    marketingConsent: true,
    consentTs: new Date(),
    source: 'web',
    quarantined: false,
    quarantineReason: null,
    projectType: 'new-build',
    sandbox: false,
    unsubscribedAt: null,
    nudgeSentAt: null,
    sheetsSyncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeDeps() {
  const leads = new Map<string, ReturnType<typeof makeLead>>();
  leads.set('lead-1', makeLead({ id: 'lead-1', tenantKey: 'elite-craft' }));
  leads.set('lead-2', makeLead({ id: 'lead-2', tenantKey: 'other-builder' }));

  const statusHistory: Array<{
    readonly leadId: string;
    readonly oldStatus: string;
    readonly newStatus: string;
    readonly changedBy: string;
  }> = [];

  const leadStore: LeadStore = {
    findRecentByEmailAndAddress: async () => null,
    listLeads: async () => [],
    listByTenantKey: async ({ tenantKey }) =>
      [...leads.values()].filter((l) => l.tenantKey === tenantKey),
    insert: async () => {
      throw new Error('not implemented');
    },
    findById: async (id) => leads.get(id) ?? null,
    findByEstimateId: async () => null,
    findNewestEstimateIdByEmailAndAddress: async () => null,
    updateOnRepeat: async () => {
      throw new Error('not implemented');
    },
    updateStatus: async ({ id, status }: { id: string; status: string }) => {
      const lead = leads.get(id);
      if (!lead) return null;
      const updated = { ...lead, status, updatedAt: new Date() };
      leads.set(id, updated);
      return updated;
    },
    appendStatusHistory: async ({
      leadId,
      oldStatus,
      newStatus,
      changedBy,
    }: {
      leadId: string;
      oldStatus: string | null;
      newStatus: string;
      changedBy?: string;
    }) => {
      statusHistory.push({
        leadId,
        oldStatus: oldStatus ?? 'unknown',
        newStatus,
        changedBy: changedBy ?? 'system',
      });
    },
    getStatusHistory: async () => [],
    appendNote: async () => {},
    getNotes: async () => [],
    setUnsubscribedAt: async () => null,
    findNudgeCandidates: async () => [],
    countNeverSynced: async () => 0,
    findSheetsSyncCandidates: async () => [],
    setSheetsSyncedAt: async () => null,
    setNudgeSentAt: async () => null,
    findAllByEmail: async () => [],
    deleteByEmail: async () => 0,
  };

  const audit: AdminAuditStore = {
    log: vi.fn(async () => {}),
  } as unknown as AdminAuditStore;

  const service = createBuilderLeadsService({ leadStore, audit });

  return { service, leadStore, audit, statusHistory, leads };
}

describe('builder-leads service (embed/09)', () => {
  it('listLeads returns only the builder tenant leads', async () => {
    const { service } = makeDeps();
    const result = await service.listLeads('elite-craft');
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.id).toBe('lead-1');
  });

  it('listLeads excludes other tenants leads', async () => {
    const { service } = makeDeps();
    const result = await service.listLeads('other-builder');
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.id).toBe('lead-2');
  });

  it('listLeads summary counts by status', async () => {
    const { service, leads } = makeDeps();
    leads.set(
      'lead-3',
      makeLead({ id: 'lead-3', tenantKey: 'elite-craft', status: 'won' }),
    );
    const result = await service.listLeads('elite-craft');
    expect(result.summary.total).toBe(2);
    expect(result.summary.new).toBe(1);
    expect(result.summary.won).toBe(1);
  });

  it('updateStatus transitions a tenant lead status', async () => {
    const { service, leads } = makeDeps();
    const result = await service.updateStatus(
      'lead-1',
      { status: 'contacted' },
      'elite-craft',
      'builder@example.com',
    );
    expect(result.ok).toBe(true);
    expect(leads.get('lead-1')?.status).toBe('contacted');
  });

  it('updateStatus on another tenant lead throws 403 (AC1)', async () => {
    const { service } = makeDeps();
    await expect(
      service.updateStatus(
        'lead-2',
        { status: 'won' },
        'elite-craft',
        'builder@example.com',
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('updateStatus on missing lead throws 404', async () => {
    const { service } = makeDeps();
    await expect(
      service.updateStatus(
        'missing',
        { status: 'won' },
        'elite-craft',
        'builder@example.com',
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('updateStatus appends lead_status_history on real transition', async () => {
    const { service, statusHistory } = makeDeps();
    await service.updateStatus(
      'lead-1',
      { status: 'quoted' },
      'elite-craft',
      'builder@example.com',
    );
    expect(statusHistory).toHaveLength(1);
    expect(statusHistory[0]).toMatchObject({
      leadId: 'lead-1',
      oldStatus: 'new',
      newStatus: 'quoted',
      changedBy: 'builder@example.com',
    });
  });

  it('updateStatus with same status does NOT append history', async () => {
    const { service, statusHistory } = makeDeps();
    await service.updateStatus(
      'lead-1',
      { status: 'new' },
      'elite-craft',
      'builder@example.com',
    );
    expect(statusHistory).toHaveLength(0);
  });

  it('updateStatus rejects invalid status with 400', async () => {
    const { service } = makeDeps();
    await expect(
      service.updateStatus(
        'lead-1',
        { status: 'bogus' },
        'elite-craft',
        'builder@example.com',
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
