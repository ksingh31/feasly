/**
 * Billing audit service (billing/02).
 *
 * APPEND-ONLY log of every billing state change — invoice created / status
 * transitions / disputes / charge attempts / subscription changes / SLA
 * breaches / webhook dispatches. Rows are never updated or deleted;
 * reconciliation reads this table.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import { randomUUID } from 'node:crypto';
import type { AppDb } from '../../db/client';
import { billingEvents } from '../../db/schema';

export interface BillingEventInput {
  /** Builder tenant the event belongs to. Null for platform-level events. */
  readonly tenantKey: string | null;
  /** e.g. 'invoice.created', 'invoice.disputed', 'subscription.created'. */
  readonly eventType: string;
  /** e.g. 'commission_invoice', 'stripe_subscription', 'attribution'. */
  readonly entityType: string;
  /** The entity's id (invoice id, subscription id, …). */
  readonly entityId: string;
  /** Event-specific payload (amounts, reasons, Stripe ids). */
  readonly payload?: Record<string, unknown>;
}

export interface BillingAuditRecord {
  readonly id: string;
  readonly tenantKey: string | null;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly payload: Record<string, unknown> | null;
  readonly createdAt: Date;
}

export interface BillingAuditService {
  /** Append one audit row. Never updates or deletes. */
  append(input: BillingEventInput): Promise<BillingAuditRecord>;
}

export interface BillingAuditServiceDeps {
  readonly db: AppDb;
  /** Defaults to node:crypto randomUUID; tests inject a fixed id. */
  readonly newId?: () => string;
}

export function createBillingAuditService(
  deps: BillingAuditServiceDeps,
): BillingAuditService {
  const { db } = deps;
  const newId = deps.newId ?? randomUUID;

  return {
    async append(input: BillingEventInput): Promise<BillingAuditRecord> {
      const [row] = await db
        .insert(billingEvents)
        .values({
          id: newId(),
          tenantKey: input.tenantKey,
          eventType: input.eventType,
          entityType: input.entityType,
          entityId: input.entityId,
          payload: input.payload ?? null,
        })
        .returning();
      return {
        id: row.id,
        tenantKey: row.tenantKey,
        eventType: row.eventType,
        entityType: row.entityType,
        entityId: row.entityId,
        payload: (row.payload as Record<string, unknown> | null) ?? null,
        createdAt: row.createdAt,
      };
    },
  };
}
