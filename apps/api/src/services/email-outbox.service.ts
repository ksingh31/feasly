/**
 * Email outbox drain (#750 daily email cap).
 *
 * Run by the email-outbox timer. Drops queued messages older than the max
 * age (their links are stale and the rows hold PII), then sends the oldest
 * pending messages while today's email budget lasts. Each send takes one
 * unit from the same daily cap the email service uses, so the drain can
 * never push the day past the ceiling.
 *
 * Per row: delivered (or accepted by the provider) → deleted. Invalid
 * recipient → deleted (it will never arrive). Other failures → kept with
 * the attempt recorded; the next run retries until the row ages out.
 * Logs carry counts only — never recipients or bodies.
 */
import type { DailyCap } from './daily-cap.service';
import type { EmailDelivery } from './email/email.service';
import type { EmailMessage } from './email/email.types';
import type { EmailOutboxStore } from './email-outbox.store';

export interface EmailOutboxDrainResult {
  readonly sent: number;
  /** Permanently undeliverable rows removed (invalid recipient). */
  readonly failed: number;
  /** Transient failures left queued for the next run. */
  readonly retrying: number;
  /** Rows dropped unsent for exceeding the max age. */
  readonly expired: number;
}

export interface EmailOutboxService {
  drain(): Promise<EmailOutboxDrainResult>;
}

export interface EmailOutboxServiceDeps {
  readonly store: EmailOutboxStore;
  readonly cap: DailyCap;
  /** Sends one message with retries, bypassing the cap gate (deliverWithRetry). */
  readonly send: (message: EmailMessage) => Promise<EmailDelivery>;
  /** EMAIL_OUTBOX_MAX_AGE_HOURS in ms. */
  readonly maxAgeMs: number;
  readonly clock?: () => Date;
}

export function createEmailOutboxService(
  deps: EmailOutboxServiceDeps,
): EmailOutboxService {
  const clock = deps.clock ?? (() => new Date());
  return {
    async drain(): Promise<EmailOutboxDrainResult> {
      const now = clock();
      const expired = await deps.store.deleteOlderThan(
        new Date(now.getTime() - deps.maxAgeMs),
      );
      let sent = 0;
      let failed = 0;
      let retrying = 0;
      const budget = await deps.cap.remaining();
      if (budget > 0) {
        const rows = await deps.store.listPending(budget);
        for (const row of rows) {
          // Concurrent traffic may have used the budget since `remaining()`.
          if (!(await deps.cap.take()).allowed) break;
          const delivery = await deps.send(row.message);
          if (delivery.sent || delivery.acceptedByProvider) {
            await deps.store.remove(row.id);
            sent += 1;
          } else if (delivery.emailError === 'invalid-recipient') {
            await deps.store.remove(row.id);
            failed += 1;
          } else {
            await deps.store.recordFailure(row.id, delivery.failureReason);
            retrying += 1;
          }
        }
      }
      return { sent, failed, retrying, expired };
    },
  };
}
