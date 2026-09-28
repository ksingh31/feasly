/**
 * Billing-health dashboard service (billing/03 follow-on — /admin/billing,
 * was OPS-007).
 *
 * READ-ONLY rollup for the admin dashboard. Never mutates: no charge,
 * refund, void, or subscription actions exist here. Composes read queries
 * across `commission_invoices`, `billing_events` (append-only audit), and
 * `stripe_events` — the same sources the charge paths write to — plus the
 * Stripe service's configured/test-mode flags.
 *
 * Panels:
 * - MRR: under the flat model, active Stripe subscriptions from the
 *   `subscription.created` / `subscription.cancelled` audit trail (the
 *   created payload carries `monthlyCents`). Under the commission model
 *   there are no subscriptions, so MRR is null and the dashboard instead
 *   shows trailing-30d commission collections.
 * - In-review aging buckets: <48h / <7d / overdue (`reviewDueAt` passed).
 * - Dunning: `failed` invoices with `past_due_since` taken from the
 *   `invoice.charge_failed` audit row (falls back to `updatedAt`).
 * - Webhook health: trailing-24h `stripe_events` volume, last received,
 *   by-type breakdown, plus `webhook.unhandled` / `webhook.model_mismatch`
 *   audit counts.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { BillingConfig } from '../../config';
import type { AppDb } from '../../db/client';
import {
  billingEvents,
  commissionInvoices,
  stripeEvents,
} from '../../db/schema';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import type { StripeService } from './stripe.service';
import type {
  BillingHealthBucket,
  BillingHealthDunningInvoice,
  BillingHealthResponse,
} from '@feasly/contracts';

export interface BillingHealthService {
  /** Read-only dashboard rollup. Never mutates billing state. */
  getHealth(): Promise<BillingHealthResponse>;
}

export interface BillingHealthServiceDeps {
  readonly db: AppDb;
  readonly billing: BillingConfig;
  readonly stripe: StripeService;
  /** Defaults to () => new Date(); tests inject a fixed clock. */
  readonly now?: () => Date;
}

/** Review-window aging boundaries for the in-review buckets. */
const FRESH_WINDOW_MS = 48 * 60 * 60 * 1000;
const AGING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const WEBHOOK_WINDOW_MS = 24 * 60 * 60 * 1000;
const COLLECTED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface InvoiceRow {
  readonly id: string;
  readonly tenantKey: string;
  readonly commissionCents: number;
  readonly currency: string;
  readonly status: string;
  readonly reviewDueAt: Date | null;
  readonly paidAt: Date | null;
  readonly retryCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function emptyBucket(): BillingHealthBucket {
  return { count: 0, commissionCents: 0 };
}

function addToBucket(
  bucket: BillingHealthBucket,
  row: InvoiceRow,
): BillingHealthBucket {
  return {
    count: bucket.count + 1,
    commissionCents: bucket.commissionCents + row.commissionCents,
  };
}

/**
 * The Postgres error code for a failure, unwrapping one level: Drizzle
 * throws `Error: Failed query: …` with the pg driver error as `cause`
 * (see the pipeline's error logging), while raw pg surfaces `code`
 * directly. Both shapes must map.
 */
function pgErrorCode(error: unknown): string | undefined {
  const direct = (error as { readonly code?: unknown } | null)?.code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { readonly cause?: unknown } | null)?.cause;
  const nested = (cause as { readonly code?: unknown } | null)?.code;
  return typeof nested === 'string' ? nested : undefined;
}

/**
 * Map a Postgres "undefined table" failure (42P01) to an actionable 503:
 * the dashboard depends on `commission_invoices`, `billing_events`, and
 * `stripe_events`, and if schema drift ever leaves one missing the admin
 * sees WHICH table is gone (and that the DB repair is the remedy) instead
 * of a bare 500. Everything else passes through untouched — programming
 * bugs must stay loud, and the pipeline still converts them to a generic
 * 500 with a correlation ID.
 */
function mapBillingDbError(error: unknown): unknown {
  if (pgErrorCode(error) === '42P01') {
    // The table name sits in the pg driver's message, which Drizzle nests
    // under `cause` ("Failed query: …" is the outer message).
    const messages = [
      error instanceof Error ? error.message : String(error),
      (error as { readonly cause?: unknown } | null)?.cause instanceof Error
        ? ((error as { readonly cause: Error }).cause.message ?? '')
        : '',
    ].join('\n');
    const table =
      /relation "([^"]+)" does not exist/.exec(messages)?.[1] ?? 'unknown';
    return new HttpError(
      503,
      ErrorCodes.DEPENDENCY_UNAVAILABLE,
      `Billing dashboard unavailable: table "${table}" is missing (run the DB repair)`,
      true,
    );
  }
  return error;
}

export function createBillingHealthService(
  deps: BillingHealthServiceDeps,
): BillingHealthService {
  const { db, billing, stripe } = deps;
  const now = deps.now ?? (() => new Date());

  /**
   * Latest `invoice.charge_failed` audit row for one dunning invoice: the
   * failure timestamp (as `past_due_since`) plus the recorded failure
   * reason (BILL-03). Falls back to the invoice's `updatedAt` when the
   * audit row is absent (legacy rows).
   */
  async function latestFailureFor(
    invoiceId: string,
    fallback: Date,
  ): Promise<{ at: Date; reason: string | null }> {
    const rows = await db
      .select({
        createdAt: billingEvents.createdAt,
        payload: billingEvents.payload,
      })
      .from(billingEvents)
      .where(
        and(
          eq(billingEvents.entityType, 'commission_invoice'),
          eq(billingEvents.entityId, invoiceId),
          eq(billingEvents.eventType, 'invoice.charge_failed'),
        ),
      )
      .orderBy(desc(billingEvents.createdAt))
      .limit(1);
    const latest = rows[0];
    const payload =
      latest?.payload !== null &&
      latest?.payload !== undefined &&
      typeof latest.payload === 'object'
        ? (latest.payload as Record<string, unknown>)
        : null;
    const reason = payload?.['failureReason'];
    return {
      at: latest?.createdAt ?? fallback,
      reason: typeof reason === 'string' && reason.length > 0 ? reason : null,
    };
  }

  /**
   * Flat-model MRR from the audit trail: subscriptions created minus
   * subscriptions cancelled. The `subscription.created` payload carries
   * `monthlyCents` (written by flat-plan.service.ts), so no Stripe SDK call
   * is needed — the audit rows mirror Stripe's subscription state.
   */
  async function flatMrr(): Promise<{
    cents: number;
    activeSubscriptions: number;
  }> {
    const rows = await db
      .select({
        eventType: billingEvents.eventType,
        entityId: billingEvents.entityId,
        payload: billingEvents.payload,
      })
      .from(billingEvents)
      .where(eq(billingEvents.entityType, 'stripe_subscription'));
    const created = new Map<string, number>();
    const cancelled = new Set<string>();
    for (const row of rows) {
      if (row.eventType === 'subscription.created') {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        const monthlyCents =
          typeof payload['monthlyCents'] === 'number'
            ? payload['monthlyCents']
            : 0;
        created.set(row.entityId, monthlyCents);
      } else if (row.eventType === 'subscription.cancelled') {
        cancelled.add(row.entityId);
      }
    }
    let cents = 0;
    let activeSubscriptions = 0;
    for (const [subscriptionId, monthlyCents] of created) {
      if (cancelled.has(subscriptionId)) continue;
      cents += monthlyCents;
      activeSubscriptions += 1;
    }
    return { cents, activeSubscriptions };
  }

  return {
    async getHealth(): Promise<BillingHealthResponse> {
      try {
        return await rollup();
      } catch (error) {
        // Schema drift on the billing tables must degrade to an
        // actionable error response, never a bare 500.
        throw mapBillingDbError(error);
      }
    },
  };

  /**
   * Read-only dashboard rollup. Query logic is untouched by the error
   * mapping above — getHealth() stays a thin catch around this.
   */
  async function rollup(): Promise<BillingHealthResponse> {
    const generatedAt = now();

    // Non-terminal + paid invoices are the dashboard's working set.
    // Terminal voids/drafts are noise here; paid is needed for the
    // trailing-30d collections figure.
    const invoiceRows = (await db
      .select({
        id: commissionInvoices.id,
        tenantKey: commissionInvoices.tenantKey,
        commissionCents: commissionInvoices.commissionCents,
        currency: commissionInvoices.currency,
        status: commissionInvoices.status,
        reviewDueAt: commissionInvoices.reviewDueAt,
        paidAt: commissionInvoices.paidAt,
        retryCount: commissionInvoices.retryCount,
        createdAt: commissionInvoices.createdAt,
        updatedAt: commissionInvoices.updatedAt,
      })
      .from(commissionInvoices)
      .where(
        inArray(commissionInvoices.status, [
          'in_review',
          'disputed',
          'failed',
          'finalized',
          'paid',
        ]),
      )) as InvoiceRow[];

    let under48h = emptyBucket();
    let under7d = emptyBucket();
    let overdue = emptyBucket();
    let disputed = emptyBucket();
    let collectedTrailing30d = emptyBucket();
    const dunningRows: InvoiceRow[] = [];
    const collectedCutoff = new Date(
      generatedAt.getTime() - COLLECTED_WINDOW_MS,
    );

    for (const row of invoiceRows) {
      if (row.status === 'in_review') {
        const ageMs = generatedAt.getTime() - row.createdAt.getTime();
        if (row.reviewDueAt !== null && row.reviewDueAt <= generatedAt) {
          overdue = addToBucket(overdue, row);
        } else if (ageMs < FRESH_WINDOW_MS) {
          under48h = addToBucket(under48h, row);
        } else if (ageMs < AGING_WINDOW_MS) {
          under7d = addToBucket(under7d, row);
        } else {
          // Older than 7d but the window hasn't passed (clock edge —
          // e.g. a test-shortened window): still reviewable, counts as
          // under-7d only by window, so land in overdue-adjacent under7d.
          under7d = addToBucket(under7d, row);
        }
      } else if (row.status === 'disputed') {
        disputed = addToBucket(disputed, row);
      } else if (row.status === 'failed') {
        dunningRows.push(row);
      } else if (
        row.status === 'paid' &&
        row.paidAt !== null &&
        row.paidAt >= collectedCutoff
      ) {
        collectedTrailing30d = addToBucket(collectedTrailing30d, row);
      }
    }

    const dunning: BillingHealthDunningInvoice[] = [];
    for (const row of dunningRows) {
      const failure = await latestFailureFor(row.id, row.updatedAt);
      dunning.push({
        id: row.id,
        tenantKey: row.tenantKey,
        commissionCents: row.commissionCents,
        currency: row.currency,
        pastDueSince: failure.at.toISOString(),
        retryCount: row.retryCount,
        lastFailureReason: failure.reason,
      });
    }
    // Oldest past-due first — the dunning work queue order.
    dunning.sort((a, b) => a.pastDueSince.localeCompare(b.pastDueSince));

    const mrr =
      billing.model === 'flat'
        ? await flatMrr()
        : { cents: 0, activeSubscriptions: 0 };

    // Webhook health: trailing-24h receive volume + audit health signals.
    const webhookCutoff = new Date(
      generatedAt.getTime() - WEBHOOK_WINDOW_MS,
    );
    const eventRows = await db
      .select({
        type: stripeEvents.type,
        receivedAt: stripeEvents.receivedAt,
      })
      .from(stripeEvents)
      .where(gte(stripeEvents.receivedAt, webhookCutoff));
    const byType = new Map<string, number>();
    let lastReceivedAt: Date | null = null;
    for (const row of eventRows) {
      byType.set(row.type, (byType.get(row.type) ?? 0) + 1);
      if (lastReceivedAt === null || row.receivedAt > lastReceivedAt) {
        lastReceivedAt = row.receivedAt;
      }
    }
    const byType24h = [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

    const auditSignals = await db
      .select({ eventType: billingEvents.eventType })
      .from(billingEvents)
      .where(
        and(
          gte(billingEvents.createdAt, webhookCutoff),
          inArray(billingEvents.eventType, [
            'webhook.unhandled',
            'webhook.model_mismatch',
          ]),
        ),
      );
    let unhandled24h = 0;
    let modelMismatch24h = 0;
    for (const row of auditSignals) {
      if (row.eventType === 'webhook.unhandled') unhandled24h += 1;
      else modelMismatch24h += 1;
    }

    return {
      model: billing.model,
      stripe: {
        configured: stripe.isConfigured,
        testMode: stripe.testMode,
      },
      generatedAt: generatedAt.toISOString(),
      mrr:
        billing.model === 'flat'
          ? {
              cents: mrr.cents,
              currency: billing.flatCurrency,
              activeSubscriptions: mrr.activeSubscriptions,
              source: 'stripe',
            }
          : {
              cents: null,
              currency: billing.flatCurrency,
              activeSubscriptions: 0,
              source: 'not_applicable',
            },
      collectedTrailing30d,
      inReview: { under48h, under7d, overdue },
      disputed,
      dunning,
      // BILL-03: the dunning queue needs the retry cap for "Retry n of m".
      maxChargeRetries: billing.maxChargeRetries ?? 3,
      webhooks: {
        received24h: eventRows.length,
        lastReceivedAt: lastReceivedAt?.toISOString() ?? null,
        byType24h,
        unhandled24h,
        modelMismatch24h,
      },
    };
  }
}
