/**
 * #728 audit/finance service — unit tests over a fake store: validation,
 * the export row cap (422, never truncated), CSV escaping, refunds capped
 * at the invoice total, detail parsing, and cursor handling. The
 * PGlite test (audit-finance.store.test.ts) covers the SQL end to end.
 */
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/middleware/errors';
import {
  createAuditFinanceService,
  parseDetail,
  toAuditEntry,
} from '../src/services/audit-finance.service';
import type {
  AuditFinanceStore,
  InvoiceExportRow,
  RawAuditRow,
} from '../src/services/audit-finance.store';
import { centsToDecimal, csvCell } from '../src/lib/csv';

function invoice(over: Partial<InvoiceExportRow> = {}): InvoiceExportRow {
  return {
    id: 'inv-1',
    invoiceNumber: 'INV-0001',
    createdAt: new Date('2026-11-10T12:00:00Z'),
    tenantKey: 'elite-craft',
    builderName: 'Elite Craft',
    leadId: 'lead-1',
    contractValueCents: 50_000_000,
    commissionCents: 500_000,
    commissionRateOverride: null,
    commissionRatePercent: null,
    taxCents: 0,
    totalCents: null,
    currency: 'CAD',
    status: 'paid',
    paymentMethod: 'card',
    manualPaymentMethod: null,
    paidAt: new Date('2026-11-12T12:00:00Z'),
    stripePaymentIntentId: null,
    refundedCents: 0,
    ...over,
  };
}

function makeService(store: Partial<AuditFinanceStore> = {}, exportMaxRows = 2) {
  const fullStore: AuditFinanceStore = {
    listAuditRows: vi.fn().mockResolvedValue([]),
    listInvoicesForExport: vi.fn().mockResolvedValue([]),
    findBuilderIdByTenant: vi.fn().mockResolvedValue(null),
    ...store,
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = createAuditFinanceService({
    store: fullStore,
    audit,
    config: { exportMaxRows, maxRangeDays: 31, defaultCommissionRate: 0.01, currency: 'CAD' },
    now: () => new Date('2026-11-15T08:00:00Z'),
  });
  return { service, store: fullStore, audit };
}

const STAFF = { kind: 'staff' as const, email: 'karan@feasly.test' };

describe('audit-finance service', () => {
  it('defaults the period to the current calendar month (UTC)', async () => {
    const { service, store } = makeService();
    const summary = await service.financeSummary({});
    expect(summary.from).toBe('2026-11-01T00:00:00.000Z');
    expect(summary.to).toBe('2026-12-01T00:00:00.000Z');
    expect(store.listInvoicesForExport).toHaveBeenCalledWith(
      { tenantKey: null, from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') },
      3,
    );
  });

  it.each([
    [{ from: 'yesterday' }],
    [{ from: '2026-11-10', to: '2026-11-01' }],
    [{ from: '2026-01-01', to: '2026-03-01' }], // > maxRangeDays
  ])('rejects an invalid period %j with 400', async (query) => {
    const { service } = makeService();
    await expect(service.financeSummary(query)).rejects.toMatchObject({ status: 400 });
  });

  it('refuses an export over the row cap with 422 and writes no audit row', async () => {
    const { service, audit } = makeService({
      listInvoicesForExport: vi.fn().mockResolvedValue([invoice(), invoice({ id: 'b' }), invoice({ id: 'c' })]),
    });
    const err = await service.exportInvoices({}, STAFF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('pins a builder export to the session tenant, ignoring a tenantKey param', async () => {
    const { service, store, audit } = makeService();
    await service.exportInvoices(
      { tenantKey: 'someone-else' },
      { kind: 'builder', email: 'o@elite.test', tenantKey: 'elite-craft', builderId: 'b-1' },
    );
    expect(vi.mocked(store.listInvoicesForExport).mock.calls[0]![0].tenantKey).toBe('elite-craft');
    expect(audit.log).toHaveBeenCalledWith({
      actorEmail: 'o@elite.test',
      action: 'finance.invoices_exported',
      detail: 'tenantKey=elite-craft builderId=b-1 period=2026-11-01_2026-11-30 rows=0',
    });
  });

  it('legacy invoices: total falls back to commission + tax, rate to the configured default', async () => {
    const { service } = makeService({
      listInvoicesForExport: vi.fn().mockResolvedValue([invoice({ taxCents: 101, manualPaymentMethod: 'cheque' })]),
    });
    const { csv } = await service.exportInvoices({}, STAFF);
    const row = csv.split('\r\n')[1]!.split(',');
    expect(row[6]).toBe('1'); // commission_rate_percent
    expect(row[9]).toBe('5001.01'); // total
    expect(row[12]).toBe('cheque'); // the recorded manual method wins
  });

  it('reports the invoice running refunded total, capped at the invoice total', async () => {
    const { service } = makeService({
      listInvoicesForExport: vi.fn().mockResolvedValue([
        invoice({ id: 'inv-1', status: 'void', refundedCents: 900_000 }),
        invoice({ id: 'inv-2', refundedCents: 120_000 }),
      ]),
    });
    const summary = await service.financeSummary({});
    expect(summary.refundedCents).toBe(500_000 + 120_000);
  });

  it('rejects a malformed cursor with 400', async () => {
    const { service } = makeService();
    await expect(service.listAudit({ cursor: 'not-a-cursor' })).rejects.toMatchObject({ status: 400 });
  });

  it('returns a cursor only when another page exists', async () => {
    const row = (id: string, ts: string): RawAuditRow => ({
      source: 'admin',
      id,
      ts,
      createdAt: new Date(ts),
      actorEmail: null,
      action: 'x',
      detail: null,
      tenantKey: null,
      entityType: null,
      entityId: null,
      payload: null,
    });
    const a = row('00000000-0000-4000-8000-00000000000a', '2026-11-05T10:00:00.000002Z');
    const b = row('00000000-0000-4000-8000-00000000000b', '2026-11-05T10:00:00.000001Z');
    const { service, store } = makeService({ listAuditRows: vi.fn().mockResolvedValue([a, b]) });
    const page = await service.listAudit({ limit: '1' });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    vi.mocked(store.listAuditRows).mockResolvedValueOnce([b]);
    const next = await service.listAudit({ limit: '1', cursor: page.nextCursor! });
    expect(vi.mocked(store.listAuditRows).mock.calls[1]![0].after).toEqual({
      ts: a.ts,
      key: `admin:${a.id}`,
    });
    expect(next.nextCursor).toBeNull();
  });

  it('parses key=value detail and links entities', () => {
    expect(parseDetail('leadId=l1 oldStatus=new newStatus=won')).toEqual({
      leadId: 'l1',
      oldStatus: 'new',
      newStatus: 'won',
    });
    const entry = toAuditEntry({
      source: 'admin',
      id: 'id-1',
      ts: '2026-11-05T10:00:00.000000Z',
      createdAt: new Date('2026-11-05T10:00:00Z'),
      actorEmail: 'karan@feasly.test',
      action: 'view_as.activated',
      detail: 'target=user:u-9',
      tenantKey: null,
      entityType: null,
      entityId: null,
      payload: null,
    });
    expect(entry).toMatchObject({ entityType: 'user', entityId: 'u-9', impersonation: true });
  });
});

describe('builder activity redaction', () => {
  const billing = (over: Partial<RawAuditRow>): RawAuditRow => ({
    source: 'billing',
    id: '00000000-0000-4000-8000-0000000000b1',
    ts: '2026-11-10T12:00:00.000000Z',
    createdAt: new Date('2026-11-10T12:00:00Z'),
    actorEmail: null,
    action: 'dispute.resolved',
    detail: null,
    tenantKey: 'elite-craft',
    entityType: 'billing_dispute',
    entityId: 'd-1',
    payload: null,
    ...over,
  });

  it('hides a staff dispute resolver from the actor and payload', async () => {
    const { service } = makeService({
      listAuditRows: vi.fn().mockResolvedValue([
        billing({
          actorEmail: 'staff@feasly.test',
          payload: { outcome: 'accepted', invoiceId: 'inv-1', resolvedBy: 'staff@feasly.test' },
        }),
      ]),
    });
    const res = await service.builderActivity(
      {},
      { email: 'owner@elite.test', tenantKey: 'elite-craft', builderId: 'b-1', team: true },
    );
    expect(res.items[0]).toMatchObject({
      actorEmail: null,
      payload: { outcome: 'accepted', invoiceId: 'inv-1' },
    });
    expect(JSON.stringify(res.items)).not.toContain('staff@feasly.test');
  });

  it('keeps a builder actor recorded under a non-staff payload key', async () => {
    const { service } = makeService({
      listAuditRows: vi.fn().mockResolvedValue([
        billing({
          action: 'invoice.disputed',
          actorEmail: 'owner@elite.test',
          payload: { builderEmail: 'owner@elite.test' },
        }),
      ]),
    });
    const res = await service.builderActivity(
      {},
      { email: 'owner@elite.test', tenantKey: 'elite-craft', builderId: 'b-1', team: true },
    );
    expect(res.items[0]!.actorEmail).toBe('owner@elite.test');
  });

  it('passes the entityType filter to the store (applied before the limit)', async () => {
    const { service, store } = makeService();
    await service.listAudit({ entityType: 'lead', limit: '5' });
    expect(store.listAuditRows).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'lead' }),
      6,
    );
  });
});

describe('csv helpers', () => {
  it('neutralises formula injection and quotes separators', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('Other Homes, Inc.')).toBe('"Other Homes, Inc."');
    expect(csvCell(null)).toBe('');
  });

  it('formats cents exactly', () => {
    expect(centsToDecimal(0)).toBe('0.00');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(129_629)).toBe('1296.29');
    expect(centsToDecimal(-150)).toBe('-1.50');
  });
});
