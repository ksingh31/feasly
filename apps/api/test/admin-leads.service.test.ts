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
    discarded: false,
    sandbox: false,
    leadScore: 75,
    status: 'new',
    unsubscribedAt: null,
    contactOptOutAt: null,
    consentUpdatedAt: new Date('2026-09-25T00:00:00Z'),
    nudgeSentAt: null,
    createdAt: new Date('2026-09-25T00:00:00Z'),
    projectType: 'new_build',
    builderId: null,
    ...overrides,
  };
}

/** Empty pipeline totals for listLeads mocks that don't care about counts. */
const STATUS_COUNTS = { new: 0, contacted: 0, quoting: 0, won: 0, lost: 0 };

function makeDeps(overrides?: Partial<AdminLeadsServiceDeps>): AdminLeadsServiceDeps {
  const store: AdminLeadsStore = {
    listLeads: vi.fn().mockResolvedValue({
      rows: [],
      nextCursor: null,
      totalCount: 0,
      statusCounts: STATUS_COUNTS,
    }),
    findByIdWithEstimate: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn(),
    updateQuarantine: vi.fn(),
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
        statusCounts: STATUS_COUNTS,
      });

      const result = await service.listLeads(
        { status: 'new', minScore: 50, source: 'web' },
        ADMIN_EMAIL,
      );

      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].id).toBe('lead-1');
      expect(result.nextCursor).toBe('cursor-123');
      expect(result.totalCount).toBe(1);
      expect(result.statusCounts).toEqual(STATUS_COUNTS);
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
      await expect(
        service.listLeads({ consent: 'maybe' }, ADMIN_EMAIL),
      ).rejects.toThrow();
    });

    it('maps contact consent: out when either opt-out is set, in otherwise', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      const outEmail = makeLeadRow({ unsubscribedAt: new Date('2026-09-26T00:00:00Z') });
      const outContact = makeLeadRow({
        id: 'lead-2',
        contactOptOutAt: new Date('2026-09-26T00:00:00Z'),
      });
      const inRow = makeLeadRow({ id: 'lead-3' });
      vi.mocked(deps.store.listLeads).mockResolvedValue({
        rows: [outEmail, outContact, inRow],
        nextCursor: null,
        totalCount: 3,
        statusCounts: STATUS_COUNTS,
      });

      const result = await service.listLeads({}, ADMIN_EMAIL);
      expect(result.leads.map((l) => [l.id, l.contactConsent])).toEqual([
        ['lead-1', 'out'],
        ['lead-2', 'out'],
        ['lead-3', 'in'],
      ]);
      for (const lead of result.leads) {
        expect(lead.consentUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });

    it('passes the consent filter to the store (default: no consent filter)', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.listLeads).mockResolvedValue({
        rows: [],
        nextCursor: null,
        totalCount: 0,
        statusCounts: STATUS_COUNTS,
      });

      // Default: consent is undefined — the admin view never filters by
      // consent unless Karan selects it.
      await service.listLeads({}, ADMIN_EMAIL);
      expect(deps.store.listLeads).toHaveBeenCalledWith({
        filters: expect.not.objectContaining({ consent: expect.anything() }),
        cursor: null,
        limit: 25,
      });

      await service.listLeads({ consent: 'out' }, ADMIN_EMAIL);
      expect(deps.store.listLeads).toHaveBeenCalledWith({
        filters: expect.objectContaining({ consent: 'out' }),
        cursor: null,
        limit: 25,
      });
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
      // builderId surfaced from the row (null when unassigned).
      expect(result.builderId).toBeNull();
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

  describe('approveQuarantine', () => {
    it('clears quarantine + discard flags and writes an audit row', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.findByIdWithEstimate).mockResolvedValue(
        makeLeadRow({ quarantined: true, discarded: true }),
      );
      vi.mocked(deps.store.updateQuarantine).mockResolvedValue(
        makeLeadRow({ quarantined: false, discarded: false }),
      );

      const result = await service.approveQuarantine('lead-1', ADMIN_EMAIL);

      expect(result.ok).toBe(true);
      expect(deps.store.updateQuarantine).toHaveBeenCalledWith({
        id: 'lead-1',
        quarantined: false,
        discarded: false,
      });
      expect(deps.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorEmail: ADMIN_EMAIL,
          action: 'admin_leads_quarantine_approved',
          detail: expect.stringContaining('leadId=lead-1'),
        }),
      );
    });

    it('throws 404 for unknown lead', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.findByIdWithEstimate).mockResolvedValue(null);

      await expect(
        service.approveQuarantine('lead-1', ADMIN_EMAIL),
      ).rejects.toThrow(expect.objectContaining({ status: 404 }));
      expect(deps.store.updateQuarantine).not.toHaveBeenCalled();
    });

    it('throws 422 when the lead is not quarantined', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.findByIdWithEstimate).mockResolvedValue(
        makeLeadRow({ quarantined: false }),
      );

      await expect(
        service.approveQuarantine('lead-1', ADMIN_EMAIL),
      ).rejects.toThrow(expect.objectContaining({ status: 422 }));
      expect(deps.store.updateQuarantine).not.toHaveBeenCalled();
      expect(deps.audit.log).not.toHaveBeenCalled();
    });
  });

  describe('discardQuarantine', () => {
    it('marks discarded (quarantined stays true) and writes an audit row', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.findByIdWithEstimate).mockResolvedValue(
        makeLeadRow({ quarantined: true, discarded: false }),
      );
      vi.mocked(deps.store.updateQuarantine).mockResolvedValue(
        makeLeadRow({ quarantined: true, discarded: true }),
      );

      const result = await service.discardQuarantine('lead-1', ADMIN_EMAIL);

      expect(result.ok).toBe(true);
      expect(deps.store.updateQuarantine).toHaveBeenCalledWith({
        id: 'lead-1',
        quarantined: true,
        discarded: true,
      });
      expect(deps.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorEmail: ADMIN_EMAIL,
          action: 'admin_leads_quarantine_discarded',
          detail: expect.stringContaining('leadId=lead-1'),
        }),
      );
    });

    it('is idempotent: already-discarded is a no-op success', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.findByIdWithEstimate).mockResolvedValue(
        makeLeadRow({ quarantined: true, discarded: true }),
      );

      const result = await service.discardQuarantine('lead-1', ADMIN_EMAIL);

      expect(result.ok).toBe(true);
      expect(deps.store.updateQuarantine).not.toHaveBeenCalled();
      expect(deps.audit.log).not.toHaveBeenCalled();
    });

    it('throws 404 for unknown lead', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.findByIdWithEstimate).mockResolvedValue(null);

      await expect(
        service.discardQuarantine('lead-1', ADMIN_EMAIL),
      ).rejects.toThrow(expect.objectContaining({ status: 404 }));
      expect(deps.store.updateQuarantine).not.toHaveBeenCalled();
    });

    it('throws 422 when the lead is not quarantined', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.findByIdWithEstimate).mockResolvedValue(
        makeLeadRow({ quarantined: false }),
      );

      await expect(
        service.discardQuarantine('lead-1', ADMIN_EMAIL),
      ).rejects.toThrow(expect.objectContaining({ status: 422 }));
      expect(deps.store.updateQuarantine).not.toHaveBeenCalled();
      expect(deps.audit.log).not.toHaveBeenCalled();
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
        statusCounts: STATUS_COUNTS,
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
        statusCounts: STATUS_COUNTS,
      });

      const result = await service.exportCsv({}, ADMIN_EMAIL);
      const lines = result.csv.split('\n');
      expect(lines[1]).toContain('"Doe, ""John"""');
    });

    it('CSV carries the consent columns (opt-outs flagged, never hidden)', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.listLeads).mockResolvedValue({
        rows: [
          makeLeadRow({ contactOptOutAt: new Date('2026-09-26T00:00:00Z') }),
        ],
        nextCursor: null,
        totalCount: 1,
        statusCounts: STATUS_COUNTS,
      });

      const result = await service.exportCsv({}, ADMIN_EMAIL);
      const lines = result.csv.split('\n');
      expect(lines[0]).toContain('contact_consent');
      expect(lines[0]).toContain('consent_updated_at');
      expect(lines[0]).toContain('unsubscribed_at');
      expect(lines[0]).toContain('contact_opt_out_at');
      // The opted-out row is present and flagged 'out' — not suppressed.
      expect(lines[1]).toContain(',out,');
      expect(lines[1]).toContain('2026-09-26T00:00:00.000Z');
    });

    it('does not fail when a row has null dates (2026-09-27: export failed server-side)', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.listLeads).mockResolvedValue({
        rows: [
          makeLeadRow({
            consentTs: null as unknown as Date,
            consentUpdatedAt: null as unknown as Date,
            createdAt: null as unknown as Date,
          }),
        ],
        nextCursor: null,
        totalCount: 1,
        statusCounts: STATUS_COUNTS,
      });

      const result = await service.exportCsv({}, ADMIN_EMAIL);
      const lines = result.csv.split('\n');
      // Header + 1 data row; null dates render as empty cells, not a throw.
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('lead-1');
    });

    it('exports zero rows as header-only CSV', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.listLeads).mockResolvedValue({
        rows: [],
        nextCursor: null,
        totalCount: 0,
        statusCounts: STATUS_COUNTS,
      });

      const result = await service.exportCsv({}, ADMIN_EMAIL);
      const lines = result.csv.split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('id,name,email');
    });

    it('survives wrong-typed dates, undefined fields, and Invalid Dates (2026-09-28 hardening)', async () => {
      const deps = makeDeps();
      const service = createAdminLeadsService(deps);
      vi.mocked(deps.store.listLeads).mockResolvedValue({
        rows: [
          // A date arriving as a string (driver/data quirk) still serializes.
          makeLeadRow({
            id: 'lead-string-date',
            consentTs: '2026-09-25T00:00:00.000Z' as unknown as Date,
          }),
          // undefined scalar fields render as empty cells.
          makeLeadRow({
            id: 'lead-undefined',
            name: undefined as unknown as string,
            phone: undefined as unknown as string,
          }),
          // An Invalid Date degrades to an empty cell, not a throw.
          makeLeadRow({
            id: 'lead-invalid-date',
            consentTs: new Date('not-a-date'),
          }),
        ],
        nextCursor: null,
        totalCount: 3,
        statusCounts: STATUS_COUNTS,
      });

      const result = await service.exportCsv({}, ADMIN_EMAIL);
      const lines = result.csv.split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[1]).toContain('lead-string-date');
      expect(lines[1]).toContain('2026-09-25T00:00:00.000Z');
      expect(lines[2]).toContain('lead-undefined');
      expect(lines[3]).toContain('lead-invalid-date');
    });
  });
});
