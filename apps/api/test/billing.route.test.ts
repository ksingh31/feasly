/**
 * Billing route tests (billing/01 first charge path).
 *
 * Thin-route contract: validate input → enforce auth → call exactly one
 * service method → return the result. All billing logic lives in the
 * service; these tests pin the HTTP surface:
 * - POST /api/v1/billing/report-contract — builder-auth required, 400 on
 *   invalid body, delegates with the session tenant key.
 * - GET /api/v1/billing/invoices/{id} — builder sees only their tenant's
 *   invoices; admin sees all; invalid id is 400.
 * - POST /api/v1/billing/invoices/{id}/dispute — builder-auth required,
 *   reason required, tenant-scoped.
 * - POST /api/v1/billing/invoices/{id}/resolve — admin-only.
 *
 * Fakes in-memory: no DB, no network.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createBillingRoute,
  type BillingRouteDeps,
} from '../src/routes/billing.route';
import type { BillingService } from '../src/services/billing/billing.service';
import type { BuilderGuard } from '../src/middleware/builder-guard';
import type { AdminGuard } from '../src/middleware/admin-guard';

const BUILDER_SESSION = {
  email: 'builder@example.com',
  tenantKey: 'elite-craft',
};

function makeDeps(opts?: {
  readonly builderSession?: typeof BUILDER_SESSION | null;
  readonly admin?: boolean;
}): { route: ReturnType<typeof createBillingRoute>; billing: BillingService } {
  const builderSession = opts?.builderSession === undefined ? BUILDER_SESSION : opts.builderSession;
  const builderGuard: BuilderGuard = {
    requireBuilder: async () => {},
    getBuilderSession: async () =>
      builderSession === null ? null : { ...builderSession },
  } as unknown as BuilderGuard;
  const adminGuard: AdminGuard = {
    requireAdmin: async () => {
      if (!opts?.admin) {
        throw Object.assign(new Error('admin required'), { status: 401 });
      }
    },
    getAdminEmail: async () => (opts?.admin ? 'admin@feasly.dev' : null),
  } as unknown as AdminGuard;

  const billing: BillingService = {
    reportContract: vi.fn(async () => ({
      billed: true,
      invoiceId: 'inv-1',
      invoiceStatus: 'in_review',
    })),
    getInvoice: vi.fn(async (invoiceId: string, tenantKey: string | null) => {
      if (tenantKey !== null && tenantKey !== 'elite-craft') {
        throw Object.assign(new Error('forbidden'), { status: 403 });
      }
      return { id: invoiceId, tenantKey: 'elite-craft', status: 'in_review' };
    }),
    disputeInvoice: vi.fn(async () => ({
      id: 'inv-1',
      tenantKey: 'elite-craft',
      status: 'disputed',
    })),
    resolveDispute: vi.fn(async () => ({
      id: 'inv-1',
      tenantKey: 'elite-craft',
      status: 'in_review',
    })),
  } as unknown as BillingService;

  const deps: BillingRouteDeps = { billing, builderGuard, adminGuard };
  return { route: createBillingRoute(deps), billing };
}

describe('POST /api/v1/billing/report-contract', () => {
  const body = {
    leadId: '00000000-0000-4000-8000-000000000001',
    contractValueCents: 50_000_000,
    contractSignedAt: '2026-09-20T10:00:00.000Z',
  };

  it('delegates with the session tenant key and parsed contract', async () => {
    const { route, billing } = makeDeps();
    const result = await route.reportContract({}, body);

    expect(billing.reportContract).toHaveBeenCalledTimes(1);
    expect(billing.reportContract).toHaveBeenCalledWith({
      tenantKey: 'elite-craft',
      leadId: body.leadId,
      contractValueCents: 50_000_000,
      contractSignedAt: new Date('2026-09-20T10:00:00.000Z'),
    });
    expect(result).toMatchObject({ billed: true, invoiceId: 'inv-1' });
  });

  it('requires builder auth (401 without a session)', async () => {
    const { route } = makeDeps({ builderSession: null, admin: true });
    await expect(route.reportContract({}, body)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects an invalid body with 400', async () => {
    const { route, billing } = makeDeps();
    await expect(
      route.reportContract({}, { leadId: 'not-a-uuid' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(billing.reportContract).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/billing/invoices/{id}', () => {
  const id = '00000000-0000-4000-8000-000000000002';

  it('builder reads their own tenant invoice', async () => {
    const { route } = makeDeps();
    const result = await route.getInvoice({}, id);
    expect(result).toMatchObject({ id, tenantKey: 'elite-craft' });
  });

  it('admin reads any invoice', async () => {
    const { route, billing } = makeDeps({ builderSession: null, admin: true });
    const result = await route.getInvoice({}, id);
    expect(billing.getInvoice).toHaveBeenCalledWith(id, null);
    expect(result).toMatchObject({ id });
  });

  it('unauthenticated callers are rejected', async () => {
    const { route } = makeDeps({ builderSession: null, admin: false });
    await expect(route.getInvoice({}, id)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects a non-uuid id with 400', async () => {
    const { route } = makeDeps();
    await expect(route.getInvoice({}, 'nope')).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('POST /api/v1/billing/invoices/{id}/dispute', () => {
  const id = '00000000-0000-4000-8000-000000000003';

  it('builder disputes with a reason', async () => {
    const { route, billing } = makeDeps();
    const result = await route.disputeInvoice({}, id, {
      reason: 'We never signed this contract.',
    });
    expect(billing.disputeInvoice).toHaveBeenCalledWith(
      id,
      'elite-craft',
      'We never signed this contract.',
    );
    expect(result).toMatchObject({ status: 'disputed' });
  });

  it('requires a non-empty reason (400)', async () => {
    const { route, billing } = makeDeps();
    await expect(
      route.disputeInvoice({}, id, { reason: '   ' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(billing.disputeInvoice).not.toHaveBeenCalled();
  });

  it('requires builder auth', async () => {
    const { route } = makeDeps({ builderSession: null, admin: true });
    await expect(
      route.disputeInvoice({}, id, { reason: 'x' }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('POST /api/v1/billing/invoices/{id}/resolve', () => {
  const id = '00000000-0000-4000-8000-000000000004';

  it('admin resolves with resume', async () => {
    const { route, billing } = makeDeps({ builderSession: null, admin: true });
    await route.resolveDispute({}, id, { outcome: 'resume' });
    expect(billing.resolveDispute).toHaveBeenCalledWith(id, 'resume');
  });

  it('rejects an invalid outcome with 400', async () => {
    const { route, billing } = makeDeps({ builderSession: null, admin: true });
    await expect(
      route.resolveDispute({}, id, { outcome: 'maybe' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(billing.resolveDispute).not.toHaveBeenCalled();
  });

  it('builders cannot resolve (admin-only)', async () => {
    const { route, billing } = makeDeps();
    await expect(
      route.resolveDispute({}, id, { outcome: 'void' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(billing.resolveDispute).not.toHaveBeenCalled();
  });
});
