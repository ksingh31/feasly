/**
 * Post-report follow-up email (#703).
 *
 * Hourly timer: leads whose report was FIRST opened ~`delayHours` ago get
 * one "Questions about your estimate?" email pointing at the callback and
 * adjust-your-inputs actions on their report. Same stamp + retry rules as
 * the 24h nudge (email/02, #576):
 *
 *   - exactly once per lead, guarded by `leads.follow_up_sent_at`;
 *   - NON-transactional: marketing consent required (CASL), suppressed for
 *     email-unsubscribed, contact-opted-out, quarantined and sandbox
 *     leads; erased leads have no row and never match;
 *   - a failed send is NOT retried — the candidate window is one timer
 *     interval wide, so the lead ages out (a late second attempt risks a
 *     duplicate marketing email);
 *   - provider-accepted but unconfirmed counts as sent and is stamped;
 *   - flag default off (`FOLLOW_UP_EMAIL_ENABLED`): disabled = no reads,
 *     no sends.
 *
 * The email carries a FRESH owner link (the original may be near expiry);
 * existing links are left live — the homeowner already uses them.
 *
 * #838 — the "finished but no builder contact requested" nudge:
 *   - skipped when the lead already asked for a callback;
 *   - with a `queue`, the cycle only ENQUEUES one job per candidate (dedupe
 *     key per lead) and the job-queue worker sends via `sendReminder`; a
 *     failed send is retried with backoff (the stamp keeps it exactly-once)
 *     and dead-letters after max attempts. Unsubscribe cancels the pending
 *     job; the handler re-checks consent and callbacks at send time.
 */
import type { JobQueue } from './job-queue.service';
import { formatDisplayAddress } from '../lib/display-address';
import type { EmailService } from './email/email.service';
import { EmailProviderError } from './email';
import type { LeadFollowUpStore } from './lead-follow-up.store';
import type { LeadStore } from './lead.store';
import { OWNER_LINK_PURPOSE, type MagicLinkStore } from './magic-link.store';
import type { UnsubscribeService } from './unsubscribe.service';

export interface FollowUpServiceDeps {
  readonly enabled: boolean;
  readonly leads: Pick<LeadStore, 'findById'>;
  readonly followUps: LeadFollowUpStore;
  readonly magicLinks: Pick<MagicLinkStore, 'issue'>;
  readonly email: Pick<EmailService, 'sendFollowUp'>;
  readonly unsubscribe: Pick<
    UnsubscribeService,
    'isUnsubscribed' | 'isContactOptedOut' | 'buildUnsubscribeUrl'
  >;
  /** e.g. https://feasly.ca — from config, never hardcoded. */
  readonly appBaseUrl: string;
  readonly magicLinkTtlSeconds: number;
  /** Hours after the first report open before the follow-up is due. */
  readonly delayHours: number;
  /** Width of the window the timer scans. Default 1 (hourly run). */
  readonly windowHours?: number;
  /** Max candidates per run (backpressure). Default 500. */
  readonly maxCandidatesPerRun?: number;
  /** Sanitized sink for per-lead failures (never tokens/emails/keys). */
  readonly onLeadError?: (error: unknown) => void;
  /** Sanitized warnings (accepted-but-unconfirmed sends). */
  readonly onWarn?: (message: string) => void;
  readonly clock?: () => Date;
  /** #838: enqueue reminders instead of sending inline. */
  readonly queue?: Pick<JobQueue, 'enqueue'>;
}

/** #838: job type of the "no builder contact requested" reminder. */
export const NO_BUILDER_CONTACT_REMINDER_JOB = 'reminder.no-builder-contact';

export interface FollowUpService {
  runFollowUpCycle(): Promise<{ readonly sent: number; readonly skipped: number }>;
  /**
   * #838 queue handler: send the follow-up for one lead. Resolves true when
   * sent, false when excluded; throws on delivery failure (queue retries).
   * Honors the enabled flag — disabled = never sends.
   */
  sendReminder(leadId: string): Promise<boolean>;
}

export function createFollowUpService(deps: FollowUpServiceDeps): FollowUpService {
  const {
    enabled,
    leads,
    followUps,
    magicLinks,
    email,
    unsubscribe,
    appBaseUrl,
    magicLinkTtlSeconds,
    delayHours,
    windowHours = 1,
    maxCandidatesPerRun = 500,
    onLeadError = () => {},
    onWarn = (message: string) => console.warn(message),
    clock = () => new Date(),
    queue,
  } = deps;

  return {
    async runFollowUpCycle() {
      if (!enabled) return { sent: 0, skipped: 0 };
      const now = clock();
      const openedBefore = new Date(now.getTime() - delayHours * 3_600_000);
      const openedAfter = new Date(openedBefore.getTime() - windowHours * 3_600_000);
      const candidates = await followUps.findCandidates({
        openedAfter,
        openedBefore,
        limit: maxCandidatesPerRun,
      });
      let sent = 0;
      let skipped = 0;
      for (const leadId of candidates) {
        if (queue) {
          // #838: enqueue only — the job-queue worker sends (with retries).
          try {
            const { enqueued } = await queue.enqueue({
              type: NO_BUILDER_CONTACT_REMINDER_JOB,
              leadId,
              dedupeKey: `${NO_BUILDER_CONTACT_REMINDER_JOB}:${leadId}`,
            });
            if (enqueued) sent++;
            else skipped++;
          } catch (error) {
            onLeadError(error);
            skipped++;
          }
          continue;
        }
        try {
          if (await maybeFollowUp(leadId)) sent++;
          else skipped++;
        } catch (error) {
          // One bad lead must not kill the batch. Not stamped and not
          // retried (ages out of the window) — see the module doc.
          onLeadError(error);
          skipped++;
        }
      }
      return { sent, skipped };
    },
    async sendReminder(leadId: string) {
      if (!enabled) return false;
      return maybeFollowUp(leadId);
    },
  };

  async function maybeFollowUp(leadId: string): Promise<boolean> {
    // Defense in depth: re-check everything the candidate query filtered —
    // a concurrent timer, unsubscribe, or erasure may have raced us.
    const state = await followUps.findState(leadId);
    if (!state || state.followUpSentAt !== null || state.reportOpenedAt === null) {
      return false;
    }
    const lead = await leads.findById(leadId);
    if (!lead) return false;
    if (!lead.marketingConsent) return false;
    if (lead.quarantined || lead.sandbox) return false;
    if (lead.unsubscribedAt !== null || lead.contactOptOutAt !== null) return false;
    if (await unsubscribe.isUnsubscribed(lead.id)) return false;
    if (await unsubscribe.isContactOptedOut(lead.id)) return false;
    // #838: the nudge is for homeowners who have NOT asked a builder to
    // contact them yet.
    if (await followUps.hasCallbackRequest(lead.id)) return false;

    // CASL: the unsubscribe URL is mandatory on marketing mail. If the HMAC
    // secret isn't configured, fail safe — skip without stamping.
    let unsubscribeUrl: string;
    try {
      unsubscribeUrl = unsubscribe.buildUnsubscribeUrl(lead.id);
    } catch {
      return false;
    }

    const now = clock();
    const issued = await magicLinks.issue({
      leadId: lead.id,
      purpose: OWNER_LINK_PURPOSE,
      ttlSeconds: magicLinkTtlSeconds,
      clock,
    });
    const delivery = await email.sendFollowUp({
      to: lead.email,
      name: lead.name,
      address: formatDisplayAddress(lead.addressKey),
      reportUrl: `${appBaseUrl}/r/${issued.token}`,
      unsubscribeUrl,
    });
    if (!delivery.sent && delivery.acceptedByProvider) {
      onWarn(
        `follow-up: provider accepted, delivery unconfirmed; stamping as sent (code=${delivery.emailError})`,
      );
    } else if (!delivery.sent) {
      throw new EmailProviderError(`Follow-up email failed: ${delivery.failureReason}`, {
        retryable: false,
        failureCode: delivery.emailError,
      });
    }
    await followUps.setFollowUpSentAt({ leadId: lead.id, at: now });
    return true;
  }
}
