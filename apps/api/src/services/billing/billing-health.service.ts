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
 *   audit counts, plus (#711) events received but never processed and
 *   invoices 'finalized' past BILLING_SETTLEMENT_THRESHOLD_HOURS.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { BillingConfig } from '../../config';
import type { AppDb } from '../../db/client';
import {
  billingEvents,
  commissionInvoices,
  stripeEvents,
} from '../../db/schema';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import { effectiveRatePercent } from '../../lib/commission-math';
import { BUILDER_PAYMENT_METHODS } from '../../lib/payment-method';
import {
  daysOverdue,
  effectiveGraceDays,
  isDunningState,
  manualDueAt,
} from '../../lib/dunning-schedule';
import type { StripeService } from './stripe.service';
import type {
  BillingHealthAwaitingSettlementInvoice,
  BillingHealthBucket,
  BillingHealthDunningInvoice,
  BillingHealthInReviewInvoice,
  BillingHealthResponse,
  BuilderPaymentMethod,
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
/**
 * #711: an unprocessed event younger than this is most likely still being
 * handled (or awaiting Stripe's first retry) — not yet worth flagging.
 */
const UNPROCESSED_GRACE_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Default settlement threshold when config omits it (#711). */
const DEFAULT_SETTLEMENT_THRESHOLD_HOURS = 24;
/** Bounded #711 work lists so the dashboard payload stays small. */
const WEBHOOK_WORK_LIST_LIMIT = 50;

interface InvoiceRow {
  readonly id: string;
  readonly tenantKey: string;
  readonly commissionCents: number;
  readonly currency: string;
  readonly status: string;
  readonly reviewDueAt: Date | null;
  readonly paidAt: Date | null;
  readonly retryCount: number;
  readonly commissionRateOverride: number | null;
  readonly commissionRatePercent: number | null;
  readonly contractValueCents: number;
  /** Raw `payment_method` text; mapped to a planned method with a safe fallback. */
  readonly paymentMethod: string | null;
  /** #718 dunning schedule. */
  readonly retryGraceDays: number | null;
  readonly nextRetryAt: Date | null;
  readonly dunningState: string;
  readonly collectionsAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Bounded admin work queue of in-review invoices. */
const IN_REVIEW_WORK_QUEUE_LIMIT = 50;

function emptyBucket(): BillingHealthBucket {
  return { count: 0, commissionCents: 0 };
}

/**
 * The invoice's planned payment method for the admin work queue.
 * Unknown/legacy values fail safe to 'card' (the auto-charge) — the
 * same fallback the builder portal uses.
 */
function plannedPaymentMethod(row: InvoiceRow): BuilderPaymentMethod {
  return (BUILDER_PAYMENT_METHODS as ReadonlyArray<string>).includes(
    row.paymentMethod ?? '',
  )
    ? (row.paymentMethod as BuilderPaymentMethod)
    : 'card';
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
  /** #718: due date + days overdue of a manual-method in-review invoice. */
  function manualDue(
    row: InvoiceRow,
    at: Date,
  ): { dueAt: string | null; overdueDays: number } {
    if (plannedPaymentMethod(row) === 'card' || row.reviewDueAt === null) {
      return { dueAt: null, overdueDays: 0 };
    }
    const dueAt = manualDueAt(
      row.reviewDueAt,
      effectiveGraceDays(row.retryGraceDays, billing.dunningGraceDays),
    );
    return { dueAt: dueAt.toISOString(), overdueDays: daysOverdue(dueAt, at) };
  }

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
        commissionRateOverride: commissionInvoices.commissionRateOverride,
        commissionRatePercent: commissionInvoices.commissionRatePercent,
        contractValueCents: commissionInvoices.contractValueCents,
        paymentMethod: commissionInvoices.paymentMethod,
        retryGraceDays: commissionInvoices.retryGraceDays,
        nextRetryAt: commissionInvoices.nextRetryAt,
        dunningState: commissionInvoices.dunningState,
        collectionsAt: commissionInvoices.collectionsAt,
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
    const inReviewRows: InvoiceRow[] = [];
    const awaitingSettlementRows: InvoiceRow[] = [];
    const settlementThresholdHours =
      billing.settlementThresholdHours ?? DEFAULT_SETTLEMENT_THRESHOLD_HOURS;
    const settlementCutoff = new Date(
      generatedAt.getTime() - settlementThresholdHours * HOUR_MS,
    );
    const collectedCutoff = new Date(
      generatedAt.getTime() - COLLECTED_WINDOW_MS,
    );

    for (const row of invoiceRows) {
      if (row.status === 'in_review') {
        inReviewRows.push(row);
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
      } else if (row.status === 'finalized') {
        // updatedAt = when the invoice entered 'finalized' (transition()).
        if (row.updatedAt <= settlementCutoff) awaitingSettlementRows.push(row);
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
        commissionRatePercent: effectiveRatePercent(
          row,
          billing.commissionRate,
        ),
        contractValueCents: row.contractValueCents,
        pastDueSince: failure.at.toISOString(),
        retryCount: row.retryCount,
        lastFailureReason: failure.reason,
        paymentMethod: plannedPaymentMethod(row),
        nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
        dunningState: isDunningState(row.dunningState) ? row.dunningState : 'active',
        retryGraceDays: effectiveGraceDays(row.retryGraceDays, billing.dunningGraceDays),
        collectionsAt: row.collectionsAt?.toISOString() ?? null,
      });
    }
    // #718: invoices flagged for collections first (oldest flag first),
    // then oldest past-due — the dunning work queue order.
    dunning.sort((a, b) => {
      const aFlag = a.collectionsAt ?? null;
      const bFlag = b.collectionsAt ?? null;
      if (aFlag !== null && bFlag === null) return -1;
      if (aFlag === null && bFlag !== null) return 1;
      if (aFlag !== null && bFlag !== null && aFlag !== bFlag) {
        return aFlag.localeCompare(bFlag);
      }
      return a.pastDueSince.localeCompare(b.pastDueSince);
    });

    // In-review work queue: the rows an admin can mark as paid off-Stripe
    // or override the commission rate on. Most urgent review window first
    // (null reviewDueAt last), bounded so the dashboard payload stays small.
    const inReviewInvoices: BillingHealthInReviewInvoice[] = inReviewRows
      .map((row) => ({
        id: row.id,
        tenantKey: row.tenantKey,
        commissionCents: row.commissionCents,
        currency: row.currency,
        reviewDueAt: row.reviewDueAt?.toISOString() ?? null,
        commissionRatePercent: effectiveRatePercent(
          row,
          billing.commissionRate,
        ),
        contractValueCents: row.contractValueCents,
        paymentMethod: plannedPaymentMethod(row),
        // #718: "awaiting manual payment — N days" for manual methods.
        ...manualDue(row, generatedAt),
        sortKey: row.reviewDueAt?.getTime() ?? Number.MAX_SAFE_INTEGER,
      }))
      .sort((a, b) => a.sortKey - b.sortKey)
      .slice(0, IN_REVIEW_WORK_QUEUE_LIMIT)
      .map(({ sortKey: _sortKey, ...rest }) => rest);

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

    // #711: recorded-but-unprocessed events (handler threw), any age.
    const unprocessedRows = await db
      .select({
        eventId: stripeEvents.eventId,
        type: stripeEvents.type,
        receivedAt: stripeEvents.receivedAt,
      })
      .from(stripeEvents)
      .where(
        and(
          isNull(stripeEvents.processedAt),
          lte(
            stripeEvents.receivedAt,
            new Date(generatedAt.getTime() - UNPROCESSED_GRACE_MS),
          ),
        ),
      )
      .orderBy(asc(stripeEvents.receivedAt))
      .limit(WEBHOOK_WORK_LIST_LIMIT);
    const unprocessed = unprocessedRows.map((row) => ({
      eventId: row.eventId,
      type: row.type,
      receivedAt: row.receivedAt.toISOString(),
    }));
    const awaitingSettlement: BillingHealthAwaitingSettlementInvoice[] =
      awaitingSettlementRows
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .slice(0, WEBHOOK_WORK_LIST_LIMIT)
        .map((row) => ({
          id: row.id,
          tenantKey: row.tenantKey,
          commissionCents: row.commissionCents,
          currency: row.currency,
          awaitingSince: row.updatedAt.toISOString(),
        }));

    return {
      model: billing.model,
      stripe: {
        configured: stripe.isConfigured,
        testMode: stripe.testMode,
        ...(stripe.provider ? { provider: stripe.provider } : {}),
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
      inReviewInvoices,
      // BILL-03: the dunning queue needs the retry cap for "Retry n of m".
      maxChargeRetries: billing.maxChargeRetries ?? 3,
      webhooks: {
        received24h: eventRows.length,
        lastReceivedAt: lastReceivedAt?.toISOString() ?? null,
        byType24h,
        unhandled24h,
        modelMismatch24h,
        unprocessed,
        awaitingSettlement,
        settlementThresholdHours,
      },
    };
  }
}
