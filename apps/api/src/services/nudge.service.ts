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
 */
import type { EmailService } from './email/email.service';
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
  readonly clock?: () => Date;
}

export interface NudgeService {
  /**
   * Run one nudge cycle. Returns how many nudges were sent and how many
   * candidates were skipped (verified / opted-out / quarantined / failed).
   */
  runNudgeCycle(): Promise<{ readonly nudged: number; readonly skipped: number }>;
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
    clock = () => new Date(),
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
        try {
          const sent = await maybeNudgeLead(lead.id);
          if (sent) nudged++;
          else skipped++;
        } catch {
          // One bad lead must not kill the batch; it stays un-nudged and
          // will be retried on the next hourly run.
          skipped++;
        }
      }

      return { nudged, skipped };
    },
  };

  /**
   * Nudge one lead. Returns true when the nudge was sent (and
   * `nudge_sent_at` stamped), false when the lead was legitimately
   * excluded. Throws on infrastructure failure so the caller can count
   * it as skipped-without-stamping (retry next run).
   */
  async function maybeNudgeLead(leadId: string): Promise<boolean> {
    const lead = await leads.findById(leadId);
    if (!lead) return false;
    // Defense in depth: the candidate query already filters NULL, but a
    // concurrent timer instance could race us. Re-check before sending.
    if (lead.nudgeSentAt) return false;
    if (lead.quarantined) return false;
    if (await unsubscribe.isUnsubscribed(lead.id)) return false;

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

    await email.sendNudge({
      to: lead.email,
      name: lead.name,
      resumeUrl: `${appBaseUrl}/r/${issued.token}`,
      unsubscribeUrl,
    });

    await leads.setNudgeSentAt({ id: lead.id, at: now });
    return true;
  }
}
