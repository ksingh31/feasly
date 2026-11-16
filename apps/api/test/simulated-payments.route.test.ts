/**
 * Simulated-payments route tests (#753): auth (401 builder / admin),
 * body validation (400), and thin delegation to the service.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSimulatedPaymentsRoute } from '../src/routes/simulated-payments.route';
import type { SimulatedPaymentsService } from '../src/services/billing/simulated-payments.service';
import type { AdminGuard } from '../src/middleware/admin-guard';
import type { BuilderGuard } from '../src/middleware/builder-guard';

const INVOICE_ID = '11111111-1111-4111-8111-111111111111';

function setup(opts: { builder?: boolean; admin?: boolean } = {}) {
  const service = {
    enabled: true,
    confirmSetup: vi.fn(async (_t: string, id: string) => ({ intentId: id, status: 'succeeded' as const })),
    authenticate: vi.fn(async (_t: string, id: string) => ({ intentId: id, status: 'succeeded' as const })),
    fireInvoiceEvent: vi.fn(async (invoiceId: string, kind: 'dispute' | 'refund' | 'delayed_failure') => ({
      invoiceId,
      paymentIntentId: 'pi_sim_1',
      kind,
      eventType: 'charge.refunded',
    })),
  } satisfies SimulatedPaymentsService;
  const builderGuard = {
    getBuilderSession: async () =>
      opts.builder === false ? null : { tenantKey: 'elite-craft', email: 'b@example.com' },
  } as unknown as BuilderGuard;
  const adminGuard = {
    requireAdmin: async () => {
      if (!opts.admin) throw Object.assign(new Error('admin required'), { status: 401 });
    },
  } as unknown as AdminGuard;
  return {
    service,
    route: createSimulatedPaymentsRoute({ simulatedPayments: service, builderGuard, adminGuard }),
  };
}

describe('POST /api/v1/billing/simulated/confirm-setup', () => {
  it('401 without a builder session', async () => {
    const { route } = setup({ builder: false });
    await expect(
      route.confirmSetup({}, { setupIntentId: 'seti_sim_1', cardNumber: '4242424242424242' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('400 for a non-test card number or a malformed intent id', async () => {
    const { route, service } = setup();
    await expect(
      route.confirmSetup({}, { setupIntentId: 'seti_sim_1', cardNumber: '5555555555554444' }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/test card/) });
    await expect(
      route.confirmSetup({}, { setupIntentId: 'pi_x', cardNumber: '4242424242424242' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(service.confirmSetup).not.toHaveBeenCalled();
  });

  it('delegates with the session tenant and the normalized card number', async () => {
    const { route, service } = setup();
    await route.confirmSetup({}, { setupIntentId: 'seti_sim_1', cardNumber: '4242 4242 4242 4242' });
    expect(service.confirmSetup).toHaveBeenCalledWith('elite-craft', 'seti_sim_1', '4242424242424242');
  });
});

describe('POST /api/v1/billing/simulated/authenticate', () => {
  it('401 without a builder session', async () => {
    const { route } = setup({ builder: false });
    await expect(route.authenticate({}, { intentId: 'pi_sim_1', outcome: 'complete' })).rejects.toMatchObject({
      status: 401,
    });
  });

  it('400 for an unknown outcome', async () => {
    const { route } = setup();
    await expect(route.authenticate({}, { intentId: 'pi_sim_1', outcome: 'maybe' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('delegates for SetupIntents and PaymentIntents', async () => {
    const { route, service } = setup();
    await route.authenticate({}, { intentId: 'seti_sim_1', outcome: 'fail' });
    await route.authenticate({}, { intentId: 'pi_sim_1', outcome: 'complete' });
    expect(service.authenticate.mock.calls).toEqual([
      ['elite-craft', 'seti_sim_1', 'fail'],
      ['elite-craft', 'pi_sim_1', 'complete'],
    ]);
  });
});

describe('POST /api/v1/admin/billing/simulated/invoices/{id}/events', () => {
  it('rejects non-admins', async () => {
    const { route, service } = setup({ admin: false });
    await expect(route.fireInvoiceEvent({}, INVOICE_ID, { kind: 'dispute' })).rejects.toMatchObject({
      status: 401,
    });
    expect(service.fireInvoiceEvent).not.toHaveBeenCalled();
  });

  it('400 for a bad id, an unknown kind, or an amount on a non-refund', async () => {
    const { route } = setup({ admin: true });
    await expect(route.fireInvoiceEvent({}, 'nope', { kind: 'dispute' })).rejects.toMatchObject({ status: 400 });
    await expect(route.fireInvoiceEvent({}, INVOICE_ID, { kind: 'chargeback' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      route.fireInvoiceEvent({}, INVOICE_ID, { kind: 'dispute', amountCents: 100 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('delegates a partial refund', async () => {
    const { route, service } = setup({ admin: true });
    const res = await route.fireInvoiceEvent({}, INVOICE_ID, { kind: 'refund', amountCents: 500 });
    expect(service.fireInvoiceEvent).toHaveBeenCalledWith(INVOICE_ID, 'refund', 500);
    expect(res.eventType).toBe('charge.refunded');
  });
});
