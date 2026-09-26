/**
 * Shared report-token resolution (phase-2 wiring).
 *
 * The report token IS the presented magic-link token (consumer/02): the
 * same bearer credential unlocks `GET /v1/reports/{token}`, revisions,
 * callback requests, and partner shares. Resolution mirrors the magic-link
 * verify semantics exactly:
 *
 * - unknown token, missing lead, or erased lead → 404
 * - revoked or expired link → 404 (same response — no live/dead oracle)
 * - an old link resolves to the NEWEST estimate for the email + property
 *   (consumer/02 AC2), falling back to the lead's own estimate
 *
 * The raw token is never logged and never persisted — only its SHA-256 hash
 * is compared, inside the magic-link store.
 */
import { ErrorCodes, HttpError } from '../middleware/errors';
import { isMagicLinkLive } from './magic-link.service';
import type { LeadRecord, LeadStore } from './lead.store';
import type { MagicLinkStore } from './magic-link.store';

export interface ReportContextDeps {
  readonly magicLinks: MagicLinkStore;
  readonly leads: LeadStore;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
}

export interface ResolvedReportContext {
  /** 'lead' | 'partner-share' — which flow minted the presented token. */
  readonly linkPurpose: string;
  readonly lead: LeadRecord;
  /** Newest estimate id for the lead's email + address (consumer/02). */
  readonly estimateId: string;
}

function notFound(): HttpError {
  // Deliberately the same for unknown/invalid/expired — the verify endpoint
  // already gives the UI the expired-vs-invalid distinction it needs.
  return new HttpError(
    404,
    ErrorCodes.NOT_FOUND,
    'Unknown or expired report token.',
    false,
  );
}

export async function resolveReportToken(
  deps: ReportContextDeps,
  reportToken: string,
): Promise<ResolvedReportContext> {
  const clock = deps.clock ?? (() => new Date());
  if (typeof reportToken !== 'string' || reportToken.length === 0) {
    throw notFound();
  }
  const record = await deps.magicLinks.findByToken(reportToken);
  if (!record || record.leadId === null) {
    throw notFound();
  }
  const lead = await deps.leads.findById(record.leadId);
  if (!lead) {
    throw notFound();
  }
  if (!isMagicLinkLive(record, clock())) {
    throw notFound();
  }
  const newest = await deps.leads.findNewestEstimateIdByEmailAndAddress({
    email: lead.email,
    addressKey: lead.addressKey,
  });
  return {
    linkPurpose: record.purpose,
    lead,
    estimateId: newest?.estimateId ?? lead.estimateId,
  };
}
