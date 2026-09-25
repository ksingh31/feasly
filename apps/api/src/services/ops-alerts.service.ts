/**
 * Ops alerting service (admin/06).
 *
 * One email to Karan when platform machinery needs a human — Sheets sync
 * failing, stats refresh failing, repeated webhook failures — deduplicated
 * so he's never spammed: at most one failure email per alert class per
 * 24h, one all-clear on recovery.
 *
 * Dedupe state lives in `ops_alert_state` (DB-backed) so a cold start
 * doesn't reset the window and re-spam. Delivery goes through the one
 * EmailService (story email/01); this service never sends mail itself.
 * Alert bodies carry counts and timestamps only — no PII, no secrets.
 */

import type { EmailService } from './email/email.service';
import type { OpsAlertStore } from './ops-alerts.store';

export const OPS_ALERT_TYPES = [
  'sheets_sync_failed',
  'community_stats_failed',
  'stripe_webhook_failed',
  'narrative_worker_failed',
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
  stripe_webhook_failed: {
    name: 'Stripe webhooks',
    detailsPath: '/admin/ops/billing',
  },
  narrative_worker_failed: {
    name: 'Narrative worker',
    detailsPath: '/admin/ops/narrative',
  },
};

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
      await email.sendOpsAlert({
        to: opsAlertEmail,
        title: `${copy.name} is failing`,
        summary:
          `The ${copy.name.toLowerCase()} has failed ` +
          `${context.consecutiveFailures} time(s) in a row ` +
          `(first failure at ${context.firstFailureAt.toISOString()}). ` +
          `This is an automated ops alert from Feasly.`,
        detailsUrl: `${appBaseUrl}${copy.detailsPath}`,
        firedAt: now,
      });
      await store.upsert({ type, lastFiredAt: now });
    },

    async notifyRecovered(type): Promise<void> {
      const copy = ALERT_COPY[type];
      const now = clock();
      const state = await store.findByType(type);
      if (!state?.lastFiredAt) {
        return; // nothing to clear: no alert was fired for this class
      }
      await email.sendOpsAlert({
        to: opsAlertEmail,
        title: `${copy.name} recovered`,
        summary:
          `The ${copy.name.toLowerCase()} recovered successfully. ` +
          `Alerting for this class is re-armed.`,
        detailsUrl: `${appBaseUrl}${copy.detailsPath}`,
        firedAt: now,
      });
      await store.upsert({
        type,
        lastFiredAt: null,
        lastRecoveredAt: now,
      });
    },
  };
}
