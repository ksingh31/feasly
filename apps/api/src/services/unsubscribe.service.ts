/**
 * Unsubscribe preference center — backend (email/03 + contact opt-out).
 *
 * Token-authenticated endpoints (no login):
 *
 * - `getState(token)` — GET /api/v1/unsubscribe/{token}. Read-only:
 *   describes the lead's current consent (email + calls/messages) so the
 *   frontend can render the preference page.
 * - `unsubscribe(token)` — POST /api/v1/unsubscribe/{token} with no body.
 *   Legacy one-click: opts out of emails only (idempotent).
 * - `savePreferences(token, prefs)` — POST with
 *   `{ emailOptOut, contactOptOut }`. Granular save from the preference
 *   page; opting back in clears the timestamp.
 *
 * Consent columns on `leads`: `unsubscribed_at` (email opt-out),
 * `contact_opt_out_at` (calls/messages), `consent_updated_at` (last change
 * to any flag).
 *
 * Suppression semantics (shared with email/02's nudge timer):
 * - `isUnsubscribed(leadId)` — the single check every non-transactional
 *   EMAIL sender calls. Transactional magic-link emails are NOT gated by
 *   this (they are requested content, not marketing).
 * - `isContactOptedOut(leadId)` — the check every proactive OUTREACH
 *   surface (calls/messages) calls.
 * - `buildUnsubscribeUrl(leadId)` — mints the tokenized URL for templates.
 *
 * PII discipline: tokens are never logged; `getState` returns the leadId
 * (needed by the frontend to render) but never the email address.
 */
import type {
  UnsubscribePreferencesInput,
  UnsubscribeResultResponse,
  UnsubscribeStateResponse,
} from '@feasly/contracts';
import { z } from 'zod';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { LeadStore } from './lead.store';
import {
  issueUnsubscribeToken,
  verifyUnsubscribeToken,
} from './unsubscribe-token';

export interface UnsubscribeService {
  /** Mint the one-click unsubscribe URL for a lead (email templates). */
  buildUnsubscribeUrl(leadId: string): string;
  /** GET /api/v1/unsubscribe/{token} — read-only state for the confirm page. */
  getState(token: string): Promise<UnsubscribeStateResponse>;
  /** POST /api/v1/unsubscribe/{token} — record the opt-out (idempotent). */
  unsubscribe(token: string): Promise<UnsubscribeResultResponse>;
  /**
   * POST /api/v1/unsubscribe/{token} with a preferences body — granular
   * save from the preference page. Each flag is explicit (true = opt out);
   * opting back in clears the timestamp. Idempotent per flag.
   */
  savePreferences(
    token: string,
    prefs: UnsubscribePreferencesInput,
  ): Promise<UnsubscribeResultResponse>;
  /**
   * Suppression check for non-transactional senders (email/02 nudge timer,
   * marketing). True when the lead opted out.
   */
  isUnsubscribed(leadId: string): Promise<boolean>;
  /**
   * Calls/messages suppression check for proactive outreach surfaces.
   * True when the lead opted out of contact from Feasly and associated
   * builders.
   */
  isContactOptedOut(leadId: string): Promise<boolean>;
}

export interface UnsubscribeServiceDeps {
  readonly leads: LeadStore;
  /** e.g. https://feasly.ca/unsubscribe — from config, never hardcoded. */
  readonly unsubscribeUrlBase: string;
  /**
   * HMAC secret (UNSUBSCRIBE_TOKEN_SECRET, Key Vault in prod). Absent =
   * fail-closed: every operation throws naming the variable.
   */
  readonly tokenSecret?: string;
  /** Token validity in seconds (30 days). */
  readonly tokenTtlSeconds: number;
  readonly clock?: () => Date;
}

const tokenInputSchema = z.string().trim().min(1).max(500);

function requireSecret(deps: UnsubscribeServiceDeps): string {
  if (!deps.tokenSecret) {
    throw new HttpError(
      503,
      ErrorCodes.INTERNAL_ERROR,
      'Unsubscribe is not configured: set UNSUBSCRIBE_TOKEN_SECRET ' +
        '(via a Key Vault reference in staging/production; never commit the secret).',
    );
  }
  return deps.tokenSecret;
}

export function createUnsubscribeService(
  deps: UnsubscribeServiceDeps,
): UnsubscribeService {
  const now = (): Date => deps.clock?.() ?? new Date();

  async function resolveLead(
    token: string,
  ): Promise<
    | { readonly ok: true; readonly leadId: string }
    | { readonly ok: false; readonly reason: 'invalid' | 'expired' }
  > {
    const secret = requireSecret(deps);
    const parsed = tokenInputSchema.safeParse(token);
    if (!parsed.success) {
      return { ok: false, reason: 'invalid' };
    }
    const verdict = verifyUnsubscribeToken({
      token: parsed.data,
      secret,
      ttlSeconds: deps.tokenTtlSeconds,
      now: now(),
    });
    if (!verdict.valid) {
      return { ok: false, reason: verdict.reason };
    }
    return { ok: true, leadId: verdict.claims.leadId };
  }

  return {
    buildUnsubscribeUrl(leadId: string): string {
      const secret = requireSecret(deps);
      const token = issueUnsubscribeToken({ leadId, secret, now: now() });
      const base = deps.unsubscribeUrlBase.replace(/\/+$/, '');
      return `${base}/${encodeURIComponent(token)}`;
    },

    async getState(token: string): Promise<UnsubscribeStateResponse> {
      const resolved = await resolveLead(token);
      if (!resolved.ok) {
        // Forged and expired tokens share the same 403 shape — no oracle
        // for which lead IDs exist (story AC1).
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          resolved.reason === 'expired'
            ? 'This unsubscribe link has expired. Request a fresh link from any Feasly email.'
            : 'This unsubscribe link is not valid.',
        );
      }
      const lead = await deps.leads.findById(resolved.leadId);
      if (!lead) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'This unsubscribe link is not valid.',
        );
      }
      return {
        valid: true,
        leadId: lead.id,
        emailOptedOut: lead.unsubscribedAt !== null,
        contactOptedOut: lead.contactOptOutAt !== null,
        consentUpdatedAt: lead.consentUpdatedAt.toISOString(),
        alreadyUnsubscribed: lead.unsubscribedAt !== null,
      };
    },

    async unsubscribe(token: string): Promise<UnsubscribeResultResponse> {
      const resolved = await resolveLead(token);
      if (!resolved.ok) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          resolved.reason === 'expired'
            ? 'This unsubscribe link has expired. Request a fresh link from any Feasly email.'
            : 'This unsubscribe link is not valid.',
        );
      }
      const lead = await deps.leads.findById(resolved.leadId);
      if (!lead) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'This unsubscribe link is not valid.',
        );
      }
      const already = lead.unsubscribedAt !== null;
      const saved = await deps.leads.updateConsentPreferences({
        id: lead.id,
        emailOptOut: true,
        at: now(),
      });
      return {
        unsubscribed: true,
        alreadyUnsubscribed: already,
        emailOptedOut: true,
        contactOptedOut: (saved ?? lead).contactOptOutAt !== null,
      };
    },

    async savePreferences(
      token: string,
      prefs: UnsubscribePreferencesInput,
    ): Promise<UnsubscribeResultResponse> {
      const resolved = await resolveLead(token);
      if (!resolved.ok) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          resolved.reason === 'expired'
            ? 'This unsubscribe link has expired. Request a fresh link from any Feasly email.'
            : 'This unsubscribe link is not valid.',
        );
      }
      const lead = await deps.leads.findById(resolved.leadId);
      if (!lead) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'This unsubscribe link is not valid.',
        );
      }
      const already = lead.unsubscribedAt !== null;
      const saved = await deps.leads.updateConsentPreferences({
        id: lead.id,
        emailOptOut: prefs.emailOptOut,
        contactOptOut: prefs.contactOptOut,
        at: now(),
      });
      const final = saved ?? lead;
      return {
        unsubscribed: final.unsubscribedAt !== null,
        alreadyUnsubscribed: already,
        emailOptedOut: final.unsubscribedAt !== null,
        contactOptedOut: final.contactOptOutAt !== null,
      };
    },

    async isUnsubscribed(leadId: string): Promise<boolean> {
      const lead = await deps.leads.findById(leadId);
      return lead?.unsubscribedAt != null;
    },

    async isContactOptedOut(leadId: string): Promise<boolean> {
      const lead = await deps.leads.findById(leadId);
      return lead?.contactOptOutAt != null;
    },
  };
}
