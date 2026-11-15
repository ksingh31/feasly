/**
 * #728 Function adapters: registry permissions are enforced with the
 * right path before the route runs, CSV exports go through the dedicated
 * export pipeline (own rate limits) and come back as uncached text/csv
 * attachments, and JSON reads use the general pipeline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveToRegistry } from '../src/registry/route-registry';

const enforced: string[] = [];
const pipelineUsed: string[] = [];
const pipeline = (name: string) => ({
  run: async (_req: unknown, handler: () => Promise<unknown>) => {
    pipelineUsed.push(name);
    return handler();
  },
});
const fakeApp = {
  requestPipeline: pipeline('request'),
  financeExportPipeline: pipeline('export'),
  permissionGuard: {},
  auditFinanceRoute: {
    listAudit: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    financeSummary: vi.fn().mockResolvedValue({ invoicedCents: 0 }),
    adminExportInvoices: vi.fn().mockResolvedValue({ csv: 'invoice_number\r\n', filename: 'invoices-x.csv' }),
    builderExportInvoices: vi.fn().mockResolvedValue({ csv: 'invoice_number\r\n', filename: 'invoices-b.csv' }),
    builderActivity: vi.fn().mockResolvedValue({ scope: 'self', items: [], nextCursor: null }),
  },
};

vi.mock('../src/index', () => ({
  createComposition: () => fakeApp,
  loadConfig: () => ({ corsOrigins: [] }),
  middleware: {
    resolveCorsHeaders: () => ({}),
    isPreflight: () => false,
    preflightHeaders: () => ({}),
    ensureCorrelationId: () => 'corr-1',
    securityHeaders: () => ({}),
    isProblemDetails: (r: unknown) =>
      typeof r === 'object' && r !== null && 'status' in r && 'title' in r,
    enforceRoutePermissions: async (_g: unknown, method: string, path: string) => {
      enforced.push(`${method} ${path}`);
      if (path === '/api/v1/admin/audit' && denyAudit) {
        return Promise.reject(new Error('forbidden'));
      }
    },
  },
}));

let denyAudit = false;

import { adminAuditHandler } from '../src/functions/admin-audit';
import { adminBillingSummaryHandler } from '../src/functions/admin-billing-summary';
import { adminBillingInvoicesExportHandler } from '../src/functions/admin-billing-invoices-export';
import { billingInvoicesExportHandler } from '../src/functions/billing-invoices-export';
import { builderActivityHandler } from '../src/functions/builder-activity';

type Res = { status: number; headers: Record<string, string>; body: unknown };
const ctx = () => ({ res: undefined as unknown, log: () => {} });
const req = { method: 'GET', headers: {}, query: { from: '2026-11-01' } };

beforeEach(() => {
  enforced.length = 0;
  pipelineUsed.length = 0;
  denyAudit = false;
});

describe('audit-finance adapters', () => {
  it.each([
    [adminAuditHandler, '/api/v1/admin/audit', 'request'],
    [adminBillingSummaryHandler, '/api/v1/admin/billing/summary', 'request'],
    [builderActivityHandler, '/api/v1/builder/activity', 'request'],
    [adminBillingInvoicesExportHandler, '/api/v1/admin/billing/invoices/export.csv', 'export'],
    [billingInvoicesExportHandler, '/api/v1/billing/invoices/export.csv', 'export'],
  ] as const)('enforces %s registry permissions on the right pipeline', async (handler, path, pipe) => {
    const c = ctx();
    await handler(c, req);
    expect(enforced).toEqual([`GET ${path}`]);
    expect(resolveToRegistry('GET', path)).not.toBeNull();
    expect(pipelineUsed).toEqual([pipe]);
    expect((c.res as Res).status).toBe(200);
  });

  it('serves the export as an uncached CSV attachment', async () => {
    const c = ctx();
    await billingInvoicesExportHandler(c, req);
    const res = c.res as Res;
    expect(res.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="invoices-b.csv"');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.body).toBe('invoice_number\r\n');
    expect(fakeApp.auditFinanceRoute.builderExportInvoices).toHaveBeenCalledWith(
      expect.any(Object),
      { from: '2026-11-01' },
    );
  });

  it('never runs the route when the permission check fails', async () => {
    denyAudit = true;
    fakeApp.auditFinanceRoute.listAudit.mockClear();
    await expect(adminAuditHandler(ctx(), req)).rejects.toThrow('forbidden');
    expect(fakeApp.auditFinanceRoute.listAudit).not.toHaveBeenCalled();
  });
});
