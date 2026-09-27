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

export function createBillingHealthService(
  deps: BillingHealthServiceDeps,
): BillingHealthService {
  const { db, billing, stripe } = deps;
  const now = deps.now ?? (() => new Date());

  /**
   * `past_due_since` for one dunning invoice: the latest
   * `invoice.charge_failed` audit row for the invoice; falls back to the
   * invoice's `updatedAt` when the audit row is absent (legacy rows).
   */
  async function pastDueSinceFor(
    invoiceId: string,
    fallback: Date,
  ): Promise<Date> {
    const rows = await db
      .select({ createdAt: billingEvents.createdAt })
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
    return rows[0]?.createdAt ?? fallback;
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
        dunning.push({
          id: row.id,
          tenantKey: row.tenantKey,
          commissionCents: row.commissionCents,
          currency: row.currency,
          pastDueSince: (
            await pastDueSinceFor(row.id, row.updatedAt)
          ).toISOString(),
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
        webhooks: {
          received24h: eventRows.length,
          lastReceivedAt: lastReceivedAt?.toISOString() ?? null,
          byType24h,
          unhandled24h,
          modelMismatch24h,
        },
      };
    },
  };
}
