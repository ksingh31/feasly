/**
 * Admin leads CSV export adapter test.
 *
 * Regression coverage for the full export wiring: the adapter is the ONLY
 * caller of `dispatchAdminLeads` with `csv: true`, so this test pins the
 * raw-CSV response branch end to end (adapter → dispatch → route → service
 * → CSV) with a stubbed store. A break anywhere in that chain (wrong
 * content-type, missing disposition, JSON-wrapped body) fails here.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createAdminLeadsRoute } from '../src/routes/admin-leads.route';
import { createAdminLeadsService } from '../src/services/admin-leads.service';
import type { AdminLeadRow } from '../src/services/admin-leads.store';

const ADMIN_EMAIL = 'karanbirsingh667@gmail.com';
const SESSION_COOKIE = 'feasly_admin_session=valid-test-session';

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

const STATUS_COUNTS = { new: 0, contacted: 0, quoting: 0, won: 0, lost: 0 };

// The fake composition wires the REAL route and REAL service; only the
// store (DB) and audit sink are stubbed.
const storeListLeads = vi.fn();
const auditLog = vi.fn();
const fakeApp = {
  requestPipeline: {
    run: async (
      _request: unknown,
      handler: () => Promise<unknown>,
    ): Promise<unknown> => handler(),
  },
  permissionGuard: {
    requirePermissions: vi.fn().mockResolvedValue({}),
  },
  adminLeadsRoute: createAdminLeadsRoute({
    adminLeads: createAdminLeadsService({
      store: {
        listLeads: storeListLeads,
        findByIdWithEstimate: vi.fn(),
        updateStatus: vi.fn(),
        updateQuarantine: vi.fn(),
        getMagicLinkStatus: vi.fn(),
      },
      leadStore: {
        getNotes: vi.fn().mockResolvedValue([]),
        getStatusHistory: vi.fn().mockResolvedValue([]),
      } as never,
      estimateStore: { findById: vi.fn() } as never,
      audit: {
        log: auditLog,
        append: vi.fn(async (args: { action: string; actorEmail: string | null; detail?: string }) => ({
          id: 'audit-1',
          action: args.action,
          actorEmail: args.actorEmail,
          detail: args.detail ?? null,
          createdAt: new Date(),
        })),
        recent: vi.fn().mockResolvedValue([]),
      },
      maxExportRows: 10000,
    }),
    builders: { assignLead: vi.fn() } as never,
    adminGuard: {
      async requireAdmin(
        headers: Record<string, string | string[] | undefined>,
      ): Promise<void> {
        const cookie = headers['cookie'];
        const value = Array.isArray(cookie) ? cookie[0] : cookie;
        if (value !== SESSION_COOKIE) {
          throw new Error('unauthorized');
        }
      },
      async getAdminEmail(): Promise<string> {
        return ADMIN_EMAIL;
      },
    },
  }),
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
    isProblemDetails: () => false,
    enforceRoutePermissions: async () => {},
  },
}));

// Imported after the mock so the adapter's lazy getApp() sees the stub.
import { adminLeadsExportHandler } from '../src/functions/admin-leads-export';

function context() {
  return { res: undefined as unknown, log: () => {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeApp.permissionGuard.requirePermissions.mockResolvedValue({});
  storeListLeads.mockResolvedValue({
    rows: [makeLeadRow(), makeLeadRow({ id: 'lead-2', name: 'Jane, Doe' })],
    nextCursor: null,
    totalCount: 2,
    statusCounts: STATUS_COUNTS,
  });
  auditLog.mockResolvedValue(undefined);
});

describe('admin-leads-export adapter', () => {
  it('returns raw CSV with text/csv content-type and attachment disposition', async () => {
    const ctx = context();
    await adminLeadsExportHandler(ctx, {
      method: 'GET',
      headers: { cookie: SESSION_COOKIE },
      query: {},
    });

    const res = ctx.res as {
      status: number;
      headers: Record<string, string>;
      body: unknown;
    };
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['Content-Disposition']).toMatch(
      /^attachment; filename="feasly-leads-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    // The body must be the raw CSV string — not a JSON envelope.
    expect(typeof res.body).toBe('string');
    const lines = (res.body as string).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('id,name,email');
    expect(lines[1]).toContain('lead-1');
    // CSV escaping survives the full chain.
    expect(lines[2]).toContain('"Jane, Doe"');
  });

  it('passes the request query filters through to the store', async () => {
    const ctx = context();
    await adminLeadsExportHandler(ctx, {
      method: 'GET',
      headers: { cookie: SESSION_COOKIE },
      query: { status: 'new' },
    });

    expect(storeListLeads).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ status: 'new' }),
        cursor: null,
        limit: 10000,
      }),
    );
    expect(ctx.res).toBeDefined();
  });

  it('survives rows with null dates (2026-09-27: export failed server-side)', async () => {
    storeListLeads.mockResolvedValue({
      rows: [
        makeLeadRow({
          consentTs: null as unknown as Date,
          consentUpdatedAt: null as unknown as Date,
          unsubscribedAt: null as unknown as Date,
          createdAt: null as unknown as Date,
        }),
      ],
      nextCursor: null,
      totalCount: 1,
      statusCounts: STATUS_COUNTS,
    });
    const ctx = context();
    await adminLeadsExportHandler(ctx, {
      method: 'GET',
      headers: { cookie: SESSION_COOKIE },
      query: {},
    });

    const res = ctx.res as { status: number; body: unknown };
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('string');
    expect((res.body as string).split('\n')).toHaveLength(2);
  });

  it('survives hostile rows: invalid dates, quotes, newlines, unicode', async () => {
    // 2026-09-28 QA: authenticated export of 30 real filtered leads failed
    // with a generic toast. The serializer hardens per-row, but nothing
    // pinned the full adapter chain against realistic dirty rows — one
    // hostile value must never kill the whole file.
    storeListLeads.mockResolvedValue({
      rows: [
        makeLeadRow({
          id: 'lead-bad-date',
          name: 'O"Brien,\nJr.',
          addressKey: '123 Main St NW, Calgary, AB T2N 1N4',
          consentTs: new Date('not-a-date') as unknown as Date,
          createdAt: new Date(Number.NaN) as unknown as Date,
        }),
        makeLeadRow({
          id: 'lead-unicode',
          name: 'José García 🏠',
          email: 'jose+test@example.com',
          phone: undefined as unknown as string,
          leadScore: Number.NaN as unknown as number,
        }),
        makeLeadRow({
          id: 'lead-nulls',
          name: null as unknown as string,
          email: null as unknown as string,
          tenantKey: undefined as unknown as null,
        }),
      ],
      nextCursor: null,
      totalCount: 3,
      statusCounts: STATUS_COUNTS,
    });
    const ctx = context();
    await adminLeadsExportHandler(ctx, {
      method: 'GET',
      headers: { cookie: SESSION_COOKIE },
      query: { status: 'new', search: 'calgary' },
    });

    const res = ctx.res as { status: number; body: unknown };
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('string');
    const body = res.body as string;
    // Every row made it into the file — none dropped, none threw. (A name
    // containing a real newline is legal CSV inside quotes, so assert on
    // content rather than line count.)
    expect(body).toContain('lead-bad-date');
    expect(body).toContain('lead-unicode');
    expect(body).toContain('lead-nulls');
    expect(body).toContain('"O""Brien,');
    // Invalid dates serialize empty rather than "Invalid Date".
    expect(body).not.toContain('Invalid Date');
  });
});
