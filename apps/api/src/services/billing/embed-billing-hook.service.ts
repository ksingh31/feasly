/**
 * Embed billing hook (embed/04).
 *
 * A single, clearly-marked hook point where the builder billing decision
 * (flat vs 1% commission — Karan decided 2026-09-24: 1% commission,
 * config-switchable to flat) will plug in for embed tenants.
 *
 * TODAY THIS IS A NO-OP: it writes exactly one append-only row to the
 * `billing_events` audit table per call (for future reconciliation) and
 * returns `{ billed: false, reason: 'billing_not_enabled' }`.
 *
 * IRON RULE: no charge path exists. No Stripe SDK, no charge code, no webhook
 * in the embed track. Any future billing story must DELETE this placeholder's
 * no-op and build the real charge path — not build beside it.
 *
 * Only services and composition.ts may import from src/db/ — this service
 * writes via the injected BillingAuditService, never touching db directly.
 */
import type { BillingAuditService } from './billing-audit.service';

/** Billable events in the embed track. */
export type BillableEventType = 'lead_created' | 'lead_won';

/** The no-op result: nothing was billed, billing is not enabled. */
export interface BillableEventResult {
  readonly billed: false;
  readonly reason: 'billing_not_enabled';
}

export interface EmbedBillingHookService {
  /**
   * Record a billable event for an embed tenant.
   *
   * Appends exactly one row to `billing_events` (eventType `embed.<event>`,
   * entityType `embed_billing_hook`) and returns the not-enabled payload.
   * Never charges, never touches Stripe.
   */
  recordBillableEvent(
    tenantId: string,
    event: BillableEventType,
  ): Promise<BillableEventResult>;
}

export interface EmbedBillingHookServiceDeps {
  readonly audit: BillingAuditService;
}

const NOT_ENABLED: BillableEventResult = Object.freeze({
  billed: false,
  reason: 'billing_not_enabled',
});

export function createEmbedBillingHookService(
  deps: EmbedBillingHookServiceDeps,
): EmbedBillingHookService {
  const { audit } = deps;

  return {
    async recordBillableEvent(
      tenantId: string,
      event: BillableEventType,
    ): Promise<BillableEventResult> {
      await audit.append({
        tenantKey: tenantId,
        eventType: `embed.${event}`,
        entityType: 'embed_billing_hook',
        // The entity IS the hook invocation; use a deterministic id so
        // duplicate calls are distinguishable by timestamp, not by key.
        entityId: `${tenantId}:${event}`,
        payload: {
          event,
          billed: false,
          reason: 'billing_not_enabled',
        },
      });
      return NOT_ENABLED;
    },
  };
}
