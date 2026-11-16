/**
 * Thin simulated-payments routes (#753) — dev/test mode only.
 *
 * - `POST /api/v1/billing/simulated/confirm-setup` — builder saves a test
 *   card against their SetupIntent (stand-in for Stripe Elements).
 * - `POST /api/v1/billing/simulated/authenticate` — builder completes (or
 *   fails) the 3D Secure challenge on a SetupIntent / PaymentIntent.
 * - `POST /api/v1/admin/billing/simulated/invoices/{id}/events` — admin dev
 *   panel fires a dispute, dashboard refund or delayed failure.
 *
 * All three are 404 unless `PAYMENTS_PROVIDER=simulated` (service).
 *
 * Hard rules (enforced by test/boundaries.test.ts):
 * - a route NEVER imports from src/db/
 * - a route NEVER reads process.env (config arrives via the service)
 * - a route depends on the service *interface*, never the implementation
 */
import { z } from 'zod';
import {
  SIMULATED_TEST_CARDS,
  type SimulatedIntentResponse,
  type SimulatedInvoiceEventResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminGuard } from '../middleware/admin-guard';
import type { BuilderGuard } from '../middleware/builder-guard';
import type { SimulatedPaymentsService } from '../services/billing/simulated-payments.service';

type Headers = Record<string, string | string[] | undefined>;

export interface SimulatedPaymentsRouteDeps {
  readonly simulatedPayments: SimulatedPaymentsService;
  readonly builderGuard: BuilderGuard;
  readonly adminGuard: AdminGuard;
}

export interface SimulatedPaymentsRoute {
  /** POST /api/v1/billing/simulated/confirm-setup */
  confirmSetup(headers: Headers, body: unknown): Promise<SimulatedIntentResponse>;
  /** POST /api/v1/billing/simulated/authenticate */
  authenticate(headers: Headers, body: unknown): Promise<SimulatedIntentResponse>;
  /** POST /api/v1/admin/billing/simulated/invoices/{id}/events */
  fireInvoiceEvent(
    headers: Headers,
    id: unknown,
    body: unknown,
  ): Promise<SimulatedInvoiceEventResponse>;
}

const testCardNumbers = SIMULATED_TEST_CARDS.map((c) => c.number);

const confirmSetupSchema = z
  .object({
    setupIntentId: z.string().trim().regex(/^seti_[A-Za-z0-9_]{1,120}$/),
    cardNumber: z
      .string()
      .transform((v) => v.replace(/[\s-]/g, ''))
      .refine((v) => testCardNumbers.includes(v), {
        message: 'Test mode accepts only the listed test card numbers.',
      }),
  })
  .strict();

const authenticateSchema = z
  .object({
    intentId: z.string().trim().regex(/^(seti|pi)_[A-Za-z0-9_]{1,120}$/),
    outcome: z.enum(['complete', 'fail']),
  })
  .strict();

const invoiceEventSchema = z
  .object({
    kind: z.enum(['dispute', 'dispute_won', 'dispute_lost', 'refund', 'delayed_failure']),
    amountCents: z.number().int().positive().optional(),
  })
  .strict()
  .refine((b) => b.amountCents === undefined || b.kind === 'refund', {
    message: 'amountCents applies to refunds only.',
  });

const uuidSchema = z.string().trim().uuid();

function badRequest(message: string): HttpError {
  return new HttpError(400, ErrorCodes.VALIDATION_FAILED, message, false);
}

async function requireTenant(
  builderGuard: BuilderGuard,
  headers: Headers,
): Promise<string> {
  const session = await builderGuard.getBuilderSession(headers);
  if (!session) {
    throw new HttpError(
      401,
      ErrorCodes.UNAUTHENTICATED,
      'Builder authentication required.',
      false,
    );
  }
  return session.tenantKey;
}

export function createSimulatedPaymentsRoute(
  deps: SimulatedPaymentsRouteDeps,
): SimulatedPaymentsRoute {
  const { simulatedPayments, builderGuard, adminGuard } = deps;
  return {
    async confirmSetup(headers, body) {
      const tenantKey = await requireTenant(builderGuard, headers);
      const parsed = confirmSetupSchema.safeParse(body);
      if (!parsed.success) {
        throw badRequest(
          parsed.error.issues[0]?.message ?? 'Invalid confirm-setup body.',
        );
      }
      return simulatedPayments.confirmSetup(
        tenantKey,
        parsed.data.setupIntentId,
        parsed.data.cardNumber,
      );
    },

    async authenticate(headers, body) {
      const tenantKey = await requireTenant(builderGuard, headers);
      const parsed = authenticateSchema.safeParse(body);
      if (!parsed.success) throw badRequest('Invalid authenticate body.');
      return simulatedPayments.authenticate(
        tenantKey,
        parsed.data.intentId,
        parsed.data.outcome,
      );
    },

    async fireInvoiceEvent(headers, id, body) {
      await adminGuard.requireAdmin(headers);
      const invoiceId = uuidSchema.safeParse(id);
      if (!invoiceId.success) throw badRequest('Invalid invoice id.');
      const parsed = invoiceEventSchema.safeParse(body);
      if (!parsed.success) {
        throw badRequest(
          parsed.error.issues[0]?.message ?? 'Invalid simulated event body.',
        );
      }
      return simulatedPayments.fireInvoiceEvent(
        invoiceId.data,
        parsed.data.kind,
        parsed.data.amountCents,
      );
    },
  };
}
