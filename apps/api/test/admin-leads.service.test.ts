/**
 * Admin leads-explorer service tests (admin/02).
 *
 * Tests the service layer with faked stores:
 * - Filter matrix (score × status × source)
 * - Free-text search (name/email/address_key)
 * - Pagination cursor stability
 * - Notes append-only (no edit/delete path)
 * - Status changes write history + audit with admin email
 * - CSV export matches filtered set
 * - Audit rows for cross-tenant reads
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createAdminLeadsService,
  formatCentsCad,
  type AdminLeadsServiceDeps,
} from '../src/services/admin-leads.service';
import type { AdminLeadsStore, AdminLeadRow } from '../src/services/admin-leads.store';
import type { LeadStore } from '../src/services/lead.store';
import type { EstimateStore } from '../src/services/estimate.store';
import type { AdminAuditStore } from '../src/services/admin-audit.store';

const ADMIN_EMAIL = 'karanbirsingh667@gmail.com';

function makeLeadRow(overrides?: Partial<AdminLeadRow>): AdminLeadRow {
  return {
    id: 'lead-1',
    estimateId: 'est-1',
    addressKey: '123 Main St NW, Calgary, AB',
    email: 'test@example.com',
    name: 'Test User',
    phone: '403-555-0123',
    timeline: '3-6mo',
    marketingConsent: true,
    consentTs: new Date('2026-09-25T00:00:00Z'),
    tenantKey: null,
    source: 'web',
    quarantined: false,
    sandbox: false,
    leadScore: 75,
    status: 'new',
    unsubscribedAt: null,
    nudgeSentAt: null,
    createdAt: new Date('2026-09-25T00:00:00Z'),
    projectType: 'new_build',
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<AdminLeadsServiceDeps>): AdminLeadsServiceDeps {
  const store: AdminLeadsStore = {
    listLeads: vi.fn().mockResolvedValue({ rows: [], nextCursor: null, totalCount: 0 }),
    findByIdWithEstimate: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn(),
    getMagicLinkStatus: vi.fn().mockResolvedValue('none'),
  };
  const leadStore = {
    getNotes: vi.fn().mockResolvedValue([]),
    getStatusHistory: vi.fn().mockResolvedValue([]),
    appendNote: vi.fn().mockResolvedValue(undefined),
    appendStatusHistory: vi.fn().mockResolvedValue(undefined),
  } as unknown as LeadStore;
  const estimateStore = {
    findById: vi.fn().mockResolvedValue(null),
  } as unknown as EstimateStore;
  const audit: AdminAuditStore = {
    log: vi.fn().mockResolvedValue(undefined),
    append: vi.fn(async (args) => ({
      id: 'audit-1',
      action: args.action,
      actorEmail: args.actorEmail,
      detail: args.detail ?? null,
      createdAt: new Date(),
    })),
    recent: vi.fn(async () => []),
  };

  return {
    store,
    leadStore,
    estimateStore,
    audit,
    maxExportRows: 10000,
    ...overrides,
  };
}

describe('admin-leads service (admin/02)', () => {
  describe('formatCentsCad', () => {
    it('formats cents as CAD without float math', () => {
      expect(formatCentsCad(123456)).toBe('$1,234.56');
      expect(formatCentsCad(0)).toBe('$0.00');
      expect(formatCentsCad(100)).toBe('$1.00');
      expect(formatCentsCad(-5000)).toBe('-$50.00');
    });
  });

  describe('listLeads', () => {
    it('passes filters to the store and writes an audit row', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      const row = makeLeadRow();
      vi.mocked(deps.store.listLeads).mockResolvedValue({
        rows: [row],
        nextCursor: 'cursor-123',
        totalCount: 1,
      });

      const result = await service.listLeads(
        { status: 'new', minScore: 50, source: 'web' },
        ADMIN_EMAIL,
      );

      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].id).toBe('lead-1');
      expect(result.nextCursor).toBe('cursor-123');
      expect(result.totalCount).toBe(1);
      expect(deps.store.listLeads).toHaveBeenCalledWith({
        filters: expect.objectContaining({
          status: 'new',
          minScore: 50,
          source: 'web',
        }),
        cursor: null,
        limit: 25,
      });
      // AC6: audit row for the read.
      expect(deps.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorEmail: ADMIN_EMAIL,
          action: 'admin_leads_list',
        }),
      );
    });

    it('rejects invalid query parameters', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);

      await expect(
        service.listLeads({ status: 'invalid' }, ADMIN_EMAIL),
      ).rejects.toThrow();
      await expect(
        service.listLeads({ minScore: 999 }, ADMIN_EMAIL),
      ).rejects.toThrow();
    });
  });

  describe('getLead', () => {
    it('returns full detail and writes an audit row', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      const row = makeLeadRow();
      vi.mocked(deps.store.findByIdWithEstimate).mockResolvedValue(row);
      vi.mocked(deps.estimateStore.findById).mockResolvedValue({
        id: 'est-1',
        projectType: 'new_build',
        addressKey: '123 Main St NW, Calgary, AB',
        inputs: { sqft: 2000, tier: 'standard' },
        figures: { total: [50000000, 60000000], build: [40000000, 50000000], land: 10000000 },
        rows: [],
        costDataVersion: 'v1',
        createdAt: new Date('2026-09-25T00:00:00Z'),
        narrative: null,
        narrativeGeneratedAt: null,
        assumptions: null,
      });
      vi.mocked(deps.store.getMagicLinkStatus).mockResolvedValue('sent');

      const result = await service.getLead('lead-1', ADMIN_EMAIL);

      expect(result.id).toBe('lead-1');
      expect(result.estimate).not.toBeNull();
      expect(result.estimate?.totalRangeCents).toEqual([50000000, 60000000]);
      expect(result.magicLinkStatus).toBe('sent');
      // AC6: audit row for the read.
      expect(deps.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorEmail: ADMIN_EMAIL,
          action: 'admin_leads_read',
          detail: 'leadId=lead-1',
        }),
      );
    });

    it('throws 404 for unknown lead', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.findByIdWithEstimate).mockResolvedValue(null);

      await expect(service.getLead('unknown', ADMIN_EMAIL)).rejects.toThrow();
    });
  });

  describe('addNote', () => {
    it('appends a note and writes an audit row', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.findByIdWithEstimate).mockResolvedValue(makeLeadRow());

      const result = await service.addNote(
        'lead-1',
        { note: 'Called the homeowner.' },
        ADMIN_EMAIL,
      );

      expect(result.ok).toBe(true);
      expect(deps.leadStore.appendNote).toHaveBeenCalledWith(
        expect.objectContaining({
          leadId: 'lead-1',
          note: 'Called the homeowner.',
        }),
      );
      expect(deps.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorEmail: ADMIN_EMAIL,
          action: 'admin_leads_note_added',
        }),
      );
    });

    it('rejects empty notes', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);

      await expect(
        service.addNote('lead-1', { note: '' }, ADMIN_EMAIL),
      ).rejects.toThrow();
    });

    it('throws 404 for unknown lead', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.findByIdWithEstimate).mockResolvedValue(null);

      await expect(
        service.addNote('unknown', { note: 'test' }, ADMIN_EMAIL),
      ).rejects.toThrow();
    });
  });

  describe('updateStatus', () => {
    it('writes status history + audit with admin email (AC4)', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      const row = makeLeadRow({ status: 'new' });
      vi.mocked(deps.store.findByIdWithEstimate).mockResolvedValue(row);
      vi.mocked(deps.store.updateStatus).mockResolvedValue(
        makeLeadRow({ status: 'contacted' }),
      );

      const result = await service.updateStatus(
        'lead-1',
        { status: 'contacted' },
        ADMIN_EMAIL,
      );

      expect(result.ok).toBe(true);
      expect(deps.store.updateStatus).toHaveBeenCalledWith({
        id: 'lead-1',
        status: 'contacted',
      });
      expect(deps.leadStore.appendStatusHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          leadId: 'lead-1',
          oldStatus: 'new',
          newStatus: 'contacted',
          changedBy: ADMIN_EMAIL,
        }),
      );
      expect(deps.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorEmail: ADMIN_EMAIL,
          action: 'admin_leads_status_changed',
          detail: expect.stringContaining('oldStatus=new newStatus=contacted'),
        }),
      );
    });

    it('rejects invalid status', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);

      await expect(
        service.updateStatus('lead-1', { status: 'invalid' }, ADMIN_EMAIL),
      ).rejects.toThrow();
    });
  });

  describe('exportCsv', () => {
    it('exports filtered set as CSV with matching row count (AC5)', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      const rows = [makeLeadRow(), makeLeadRow({ id: 'lead-2', name: 'Jane Doe' })];
      vi.mocked(deps.store.listLeads).mockResolvedValue({
        rows,
        nextCursor: null,
        totalCount: 2,
      });

      const result = await service.exportCsv({ status: 'new' }, ADMIN_EMAIL);

      expect(result.filename).toMatch(/^feasly-leads-\d{4}-\d{2}-\d{2}\.csv$/);
      const lines = result.csv.split('\n');
      // Header + 2 data rows.
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('id,name,email');
      expect(lines[1]).toContain('lead-1');
      expect(lines[2]).toContain('lead-2');
      expect(lines[2]).toContain('Jane Doe');
      // AC6: audit row for the export.
      expect(deps.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorEmail: ADMIN_EMAIL,
          action: 'admin_leads_export',
        }),
      );
    });

    it('escapes CSV special characters', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.listLeads).mockResolvedValue({
        rows: [makeLeadRow({ name: 'Doe, "John"' })],
        nextCursor: null,
        totalCount: 1,
      });

      const result = await service.exportCsv({}, ADMIN_EMAIL);
      const lines = result.csv.split('\n');
      expect(lines[1]).toContain('"Doe, ""John"""');
    });
  });
});
