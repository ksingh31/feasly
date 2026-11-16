/**
 * Ops alerting service (admin/06).
 *
 * One email to Karan when platform machinery needs a human — Sheets sync
 * failing, stats refresh failing, repeated webhook failures, stale Postgres
 * backups — deduplicated so he's never spammed: at most one failure email
 * per alert class per 24h, one all-clear on recovery.
 *
 * Dedupe state lives in `ops_alert_state` (DB-backed) so a cold start
 * doesn't reset the window and re-spam. Delivery goes through the one
 * EmailService (story email/01); this service never sends mail itself.
 * Alert bodies carry counts and timestamps only — no PII, no secrets.
 */

import type { EmailDelivery, EmailService } from './email/email.service';
import { EmailProviderError } from './email';
import type { OpsAlertStore } from './ops-alerts.store';

export const OPS_ALERT_TYPES = [
  'sheets_sync_failed',
  'community_stats_failed',
  'community_lots_failed',
  'stripe_webhook_failed',
  'narrative_worker_failed',
  'backup_missed',
  'billing_dispute_sla_breached',
  'neighbourhood_data_failed',
  'billing_refund_pending_stale',
] as const;

export type OpsAlertType = (typeof OPS_ALERT_TYPES)[number];

interface AlertCopy {
  /** Human-readable name used in the email title/body. */
  readonly name: string;
  /** Admin view the alert deep-links to (appended to the app base URL). */
  readonly detailsPath: string;
}

const ALERT_COPY: Record<OpsAlertType, AlertCopy> = {
  sheets_sync_failed: {
    name: 'Google Sheets sync',
    detailsPath: '/admin/ops/sheets',
  },
  community_stats_failed: {
    name: 'Community stats refresh',
    detailsPath: '/admin/ops/community-stats',
  },
  community_lots_failed: {
    name: 'Community lots refresh',
    detailsPath: '/admin/ops/community-stats',
  },
  stripe_webhook_failed: {
    name: 'Stripe webhooks',
    detailsPath: '/admin/ops/billing',
  },
  narrative_worker_failed: {
    name: 'Narrative worker',
    detailsPath: '/admin/ops/narrative',
  },
  backup_missed: {
    name: 'Postgres backup',
    detailsPath: '/admin/ops/backup',
  },
  billing_dispute_sla_breached: {
    name: 'Billing dispute SLA',
    detailsPath: '/admin/disputes',
  },
  neighbourhood_data_failed: {
    name: 'Neighbourhood data refresh',
    detailsPath: '/admin/ops/neighbourhood-data',
  },
  // #892: card refunds stuck 'pending' past BILLING_PENDING_REFUND_ALERT_HOURS.
  billing_refund_pending_stale: {
    name: 'Pending card refunds',
    detailsPath: '/admin/billing/invoices',
  },
};

/**
 * Shared delivery check for every ops-alert send (issue #573).
 *
 * - `sent: true` → returns normally.
 * - Accepted-but-unconfirmed (`acceptedByProvider: true`: ACS accepted the
 *   message, delivery polling timed out) → logs a warning and returns
 *   normally. The email service deliberately never re-sends these (P0
 *   2026-09-27), so the caller must treat it like a send: record dedupe
 *   state and don't fail the run — throwing would fail the timer/webhook
 *   and re-send the alert on the next check (duplicate ops emails).
 * - Never accepted → throws, so the caller skips recording and the next
 *   check retries.
 *
 * The warning carries the alert title + sanitized provider reason only
 * (no recipient, no body).
 */
export function ensureOpsAlertDelivered(
  delivery: EmailDelivery,
  title: string,
  logWarning: (message: string) => void,
): void {
  if (delivery.sent) return;
  if (delivery.acceptedByProvider) {
    logWarning(
      `ops-alert: "${title}" accepted by provider but delivery unconfirmed ` +
        `(${delivery.failureReason}); treating as sent`,
    );
    return;
  }
  throw new EmailProviderError(
    `Ops alert email failed: ${delivery.failureReason}`,
    { retryable: false, failureCode: delivery.emailError },
  );
}

export interface OpsAlertFailureContext {
  /** How many consecutive failures triggered this notification. */
  readonly consecutiveFailures: number;
  /** When the failure streak started (rendered as "since when"). */
  readonly firstFailureAt: Date;
}

export interface OpsAlertsServiceDeps {
  readonly email: Pick<EmailService, 'sendOpsAlert'>;
  readonly store: OpsAlertStore;
  /** From config OPS_ALERT_EMAIL (standing test email until Karan names one). */
  readonly opsAlertEmail: string;
  readonly appBaseUrl: string;
  /** Dedupe window per alert class (config OPS_ALERT_DEDUPE_WINDOW_MS). */
  readonly dedupeWindowMs: number;
  readonly clock?: () => Date;
  /** Warning sink for accepted-but-unconfirmed sends. Defaults to console.warn. */
  readonly logWarning?: (message: string) => void;
}

export interface OpsAlertsService {
  /**
   * Fire a failure alert for the class. Sends at most one email per
   * class per dedupe window; repeat calls inside the window are no-ops.
   */
  notifyFailure(
    type: OpsAlertType,
    context: OpsAlertFailureContext,
  ): Promise<void>;
  /**
   * Send the all-clear once after a recovery and re-arm the class.
   * No-op when no alert was fired (never spams all-clears for healthy
   * classes).
   */
  notifyRecovered(type: OpsAlertType): Promise<void>;
}

export function createOpsAlertsService(
  deps: OpsAlertsServiceDeps,
): OpsAlertsService {
  const {
    email,
    store,
    opsAlertEmail,
    appBaseUrl,
    dedupeWindowMs,
    clock = () => new Date(),
    logWarning = (message: string) => console.warn(message),
  } = deps;

  return {
    async notifyFailure(type, context): Promise<void> {
      const copy = ALERT_COPY[type];
      const now = clock();
      const state = await store.findByType(type);
      if (
        state?.lastFiredAt &&
        now.getTime() - state.lastFiredAt.getTime() < dedupeWindowMs
      ) {
        return; // deduped: already alerted inside the window
      }
      const failureTitle = `${copy.name} is failing`;
      const failureDelivery = await email.sendOpsAlert({
        to: opsAlertEmail,
        title: failureTitle,
        summary:
          `The ${copy.name.toLowerCase()} has failed ` +
          `${context.consecutiveFailures} time(s) in a row ` +
          `(first failure at ${context.firstFailureAt.toISOString()}). ` +
          `This is an automated ops alert from Feasly.`,
        detailsUrl: `${appBaseUrl}${copy.detailsPath}`,
        firedAt: now,
      });
      // Throws only when the provider never accepted the email: then the
      // alert is not recorded as fired and the next check tries again.
      // Accepted-but-unconfirmed is recorded like a send (issue #573) so
      // dedupe holds and the timer run doesn't fail.
      ensureOpsAlertDelivered(failureDelivery, failureTitle, logWarning);
      await store.upsert({ type, lastFiredAt: now });
    },

    async notifyRecovered(type): Promise<void> {
      const copy = ALERT_COPY[type];
      const now = clock();
      const state = await store.findByType(type);
      if (!state?.lastFiredAt) {
        return; // nothing to clear: no alert was fired for this class
      }
      const recoveredTitle = `${copy.name} recovered`;
      const recoveredDelivery = await email.sendOpsAlert({
        to: opsAlertEmail,
        title: recoveredTitle,
        summary:
          `The ${copy.name.toLowerCase()} recovered successfully. ` +
          `Alerting for this class is re-armed.`,
        detailsUrl: `${appBaseUrl}${copy.detailsPath}`,
        firedAt: now,
      });
      ensureOpsAlertDelivered(recoveredDelivery, recoveredTitle, logWarning);
      await store.upsert({
        type,
        lastFiredAt: null,
        lastRecoveredAt: now,
      });
    },
  };
}
