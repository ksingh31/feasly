/**
 * 24-hour nudge service (email/02).
 *
 * Hourly timer finds leads created ~24h ago whose magic link was never
 * used and sends exactly one polite reminder with a fresh secure link.
 * The nudge is NON-transactional: it is suppressed for opted-out leads
 * (email/03), quarantined leads, and leads that verified in the meantime.
 *
 * Exactly-once is guarded by `leads.nudge_sent_at` (NULL = not yet sent).
 * The fresh link reuses the magic-link store's issue path; the previous
 * unclicked link(s) are revoked first so only the nudge link is live.
 *
 * #838 — the "started but didn't finish" reminder:
 *   - CASL: sent only to leads that gave marketing consent;
 *   - with a `queue`, the hourly cycle only ENQUEUES one job per candidate
 *     (dedupe key per lead, so a lead is never queued twice) and the
 *     job-queue worker sends via `sendReminder` — a failed send is retried
 *     with backoff (the `nudge_sent_at` stamp keeps it exactly-once) and
 *     dead-letters after the queue's max attempts. Unsubscribe cancels the
 *     pending job; the handler re-checks consent at send time anyway.
 *   - without a queue (legacy wiring / tests) the cycle sends directly.
 */
import type { JobQueue } from './job-queue.service';
import type { EmailService } from './email/email.service';
import { EmailProviderError } from './email';
import type { LeadStore } from './lead.store';
import type { MagicLinkStore } from './magic-link.store';
import type { UnsubscribeService } from './unsubscribe.service';

export interface NudgeServiceDeps {
  readonly leads: LeadStore;
  readonly magicLinks: MagicLinkStore;
  readonly email: EmailService;
  readonly unsubscribe: UnsubscribeService;
  /** e.g. https://feasly.ca — from config, never hardcoded. */
  readonly appBaseUrl: string;
  readonly magicLinkTtlSeconds: number;
  /** Hours after lead creation before the nudge is eligible. Default 24. */
  readonly nudgeDelayHours?: number;
  /** Width of the creation window the timer scans. Default 1 (hourly run). */
  readonly nudgeWindowHours?: number;
  /** Max candidates per run (backpressure). Default 500. */
  readonly maxCandidatesPerRun?: number;
  /**
   * Sink for per-lead failures (email/provider/DB). The batch catch counts
   * them as skipped without stamping — the sink makes a dead provider
   * visible before the hourly aggregate does. Sanitized at the composition
   * root (never tokens, emails, or keys).
   */
  readonly onLeadError?: (error: unknown) => void;
  /**
   * Sink for sanitized warnings (e.g. provider accepted the nudge but
   * delivery couldn't be confirmed). Messages never contain tokens,
   * emails, names, or keys. Defaults to `console.warn`.
   */
  readonly onWarn?: (message: string) => void;
  readonly clock?: () => Date;
  /** #838: enqueue reminders instead of sending inline. */
  readonly queue?: Pick<JobQueue, 'enqueue'>;
}

/** #838: job type of the "started but didn't finish" reminder. */
export const UNFINISHED_ESTIMATE_REMINDER_JOB = 'reminder.unfinished-estimate';

export interface NudgeService {
  /**
   * Run one nudge cycle. Returns how many nudges were sent and how many
   * candidates were skipped (verified / opted-out / quarantined / failed).
   */
  runNudgeCycle(): Promise<{ readonly nudged: number; readonly skipped: number }>;
  /**
   * #838 queue handler: send the reminder for one lead. Resolves true when
   * sent, false when the lead is legitimately excluded (consent withdrawn,
   * verified, already nudged …). Throws on delivery/infra failure so the
   * queue retries.
   */
  sendReminder(leadId: string): Promise<boolean>;
}

export function createNudgeService(deps: NudgeServiceDeps): NudgeService {
  const {
    leads,
    magicLinks,
    email,
    unsubscribe,
    appBaseUrl,
    magicLinkTtlSeconds,
    nudgeDelayHours = 24,
    nudgeWindowHours = 1,
    maxCandidatesPerRun = 500,
    onLeadError = () => {},
    onWarn = (message: string) => console.warn(message),
    clock = () => new Date(),
    queue,
  } = deps;

  return {
    async runNudgeCycle() {
      const now = clock();
      const createdBefore = new Date(
        now.getTime() - nudgeDelayHours * 3_600_000,
      );
      const createdAfter = new Date(
        createdBefore.getTime() - nudgeWindowHours * 3_600_000,
      );

      const candidates = await leads.findNudgeCandidates({
        createdAfter,
        createdBefore,
        limit: maxCandidatesPerRun,
      });

      let nudged = 0;
      let skipped = 0;

      for (const lead of candidates) {
        if (queue) {
          // #838: enqueue only — the job-queue worker sends (with retries).
          // Cheap pre-filter on the candidate row; the handler re-checks
          // everything at send time.
          if (!lead.marketingConsent || lead.quarantined || lead.sandbox) {
            skipped++;
            continue;
          }
          try {
            const { enqueued } = await queue.enqueue({
              type: UNFINISHED_ESTIMATE_REMINDER_JOB,
              leadId: lead.id,
              dedupeKey: `${UNFINISHED_ESTIMATE_REMINDER_JOB}:${lead.id}`,
            });
            if (enqueued) nudged++;
            else skipped++;
          } catch (error) {
            onLeadError(error);
            skipped++;
          }
          continue;
        }
        try {
          const sent = await maybeNudgeLead(lead.id);
          if (sent) nudged++;
          else skipped++;
        } catch (error) {
          // One bad lead must not kill the batch; it stays un-nudged
          // (nudge_sent_at NULL). There is NO retry: the candidate window
          // is `nudgeWindowHours` wide (default 1h, matching the hourly
          // timer), so by the next run the lead has aged out of the
          // window and the failed nudge is dropped. That is deliberate —
          // a late retry would revoke a link the homeowner may already
          // hold and risk a second marketing email (CASL). A rising
          // `skipped` count alone is not enough visibility when the
          // provider is down — the failure detail goes to the sink
          // (sanitized at the composition root).
          onLeadError(error);
          skipped++;
        }
      }

      return { nudged, skipped };
    },
    sendReminder: (leadId: string) => maybeNudgeLead(leadId),
  };

  /**
   * Nudge one lead. Returns true when the nudge was sent (and
   * `nudge_sent_at` stamped), false when the lead was legitimately
   * excluded. Throws on infrastructure failure so the caller can count
   * it as skipped-without-stamping (the nudge is dropped, not retried —
   * see the batch loop). A provider-accepted but unconfirmed send counts
   * as sent and is stamped.
   */
  async function maybeNudgeLead(leadId: string): Promise<boolean> {
    const lead = await leads.findById(leadId);
    if (!lead) return false;
    // Defense in depth: the candidate query already filters NULL, but a
    // concurrent timer instance could race us. Re-check before sending.
    if (lead.nudgeSentAt) return false;
    if (lead.quarantined) return false;
    // #838 CASL: a reminder is commercial email — consent required.
    if (!lead.marketingConsent) return false;
    // #793: sandbox (feasly_test_) leads never receive real email.
    if (lead.sandbox) return false;
    // Proactive outreach respects both opt-outs: email-unsubscribed leads
    // get no nudge, and neither do leads who opted out of calls/messages
    // ("don't contact me about my estimate" covers the nudge too).
    if (await unsubscribe.isUnsubscribed(lead.id)) return false;
    if (await unsubscribe.isContactOptedOut(lead.id)) return false;

    const links = await magicLinks.findByLeadIds([lead.id]);
    // Verified in the meantime: any used link means the homeowner unlocked
    // their estimate — no nudge. (Not stamped; the lead ages out of the
    // 24h window on its own.)
    if (links.some((l) => l.usedAt !== null)) return false;

    // CASL: the nudge is marketing, so the one-click unsubscribe URL is
    // mandatory. If the HMAC secret isn't configured, fail safe — skip
    // without stamping so the next run retries once the secret exists.
    let unsubscribeUrl: string;
    try {
      unsubscribeUrl = unsubscribe.buildUnsubscribeUrl(lead.id);
    } catch {
      return false;
    }

    const now = clock();
    // Revoke the old unclicked link(s) so only the fresh nudge link is live.
    await magicLinks.revokeByLeadIds([lead.id], now);
    const issued = await magicLinks.issue({
      leadId: lead.id,
      purpose: 'lead',
      ttlSeconds: magicLinkTtlSeconds,
      clock,
    });

    const delivery = await email.sendNudge({
      to: lead.email,
      name: lead.name,
      resumeUrl: `${appBaseUrl}/r/${issued.token}`,
      unsubscribeUrl,
    });
    if (!delivery.sent && delivery.acceptedByProvider) {
      // Accepted-but-unconfirmed (ACS beginSend succeeded, delivery poll
      // timed out): the homeowner most likely has the email, so treat it
      // as sent — same rule as lead.service. Stamping keeps lead state
      // honest and guarantees no duplicate marketing email. Sanitized:
      // failure code only, never lead id/email/name/token.
      onWarn(
        `nudge: provider accepted, delivery unconfirmed; stamping as sent (code=${delivery.emailError})`,
      );
    } else if (!delivery.sent) {
      // Don't stamp nudge_sent_at: the caller counts the throw as
      // skipped-without-stamping. The lead ages out of the window before
      // the next run, so this nudge is dropped (not retried).
      throw new EmailProviderError(`Nudge email failed: ${delivery.failureReason}`, {
        retryable: false,
        failureCode: delivery.emailError,
      });
    }

    await leads.setNudgeSentAt({ id: lead.id, at: now });
    return true;
  }
}
