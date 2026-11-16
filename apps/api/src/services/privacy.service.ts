/**
 * PIPEDA self-service privacy service (legal/02).
 *
 * Endpoints:
 *  - exportMyData: everything Feasly holds about the bearer identity.
 *  - requestErasure: two-step erasure, step 1 — records the request,
 *    returns the (draft) consequences statement and emails a confirmation
 *    link (#806: owner decision on #706 — deletion with email
 *    confirmation). Nothing is deleted here.
 *  - confirmErasure: step 2 — human-confirmed execution.
 *
 * Identity model (deliberate, documented): until BE-4's session model
 * lands there is no `users` table — identity IS the lead's normalized
 * email, and the bearer credential is the magic-link token issued at lead
 * capture. Export is therefore implicitly self-scoped: the HTTP surface
 * exposes no target selector to tamper with, so a cross-user export is
 * not expressible. The 403 + audit-row guarantee lives where a cross-user
 * target IS expressible — confirming another user's erasure request.
 *
 * Erasure semantics: lead rows (the PII store), their callback requests
 * (name/phone, #639) and waitlist signups are hard-deleted, magic
 * links are revoked (rows kept as anonymized audit — hashes only),
 * erasure_requests flips to 'completed'. Estimate snapshots are
 * insert-only by design and contain no name/email/phone — they remain as
 * anonymized aggregates, detached from identity once the leads are gone.
 *
 * PII discipline: the raw email appears only in the export payload (it IS
 * the subject's own data). Audit rows carry leadId + action only. Error
 * messages name fields and reasons, never values.
 *
 * Confirmation email (#806): step 1 mints a FRESH owner-purpose magic link
 * with a short TTL (PRIVACY_ERASE_CONFIRM_LINK_TTL_SECONDS) and emails
 * `${appBaseUrl}/privacy/confirm/${requestId}#token=${token}`. The token
 * rides in the URL fragment (never sent to a server). A duplicate request
 * (one already pending) re-sends at most once per cooldown and inside the
 * shared hourly magic-link send budget — the same email-bombing guards as
 * `POST /magic-link/reissue`. Neither the token nor the address is logged
 * or written to an audit row.
 */
import { createHash } from 'node:crypto';
import type {
  ErasureConfirmResponse,
  ErasureRequestResponse,
  PrivacyExportResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import { createRateLimiter } from '../middleware/rate-limit';
import {
  createInMemoryCooldown,
  type AnyRateLimiter,
  type SharedCooldown,
} from '../middleware/shared-rate-limit';
import { sanitizeErrorMessage } from '../lib/sanitize-error';
import type { EmailService } from './email/email.service';
import { MAGIC_LINK_SEND_BUDGET_WINDOW_MS } from './magic-link.service';
import {
  ERASURE_CONSEQUENCES_DRAFT,
  EXPORT_RETENTION_NOTICE_DRAFT,
} from '../lib/legal-copy';
import type { CallbackRequestStore } from './callback-request.store';
import type { EstimateStore } from './estimate.store';
import type { LeadStore } from './lead.store';
import { OWNER_LINK_PURPOSE, type MagicLinkStore } from './magic-link.store';
import type { PrivacyStore } from './privacy.store';
import type { WaitlistStore } from './waitlist.store';

/** A reason erasure cannot proceed yet (open dispute, in-review invoice…). */
export interface ErasureBlocker {
  readonly kind: string;
  /** Human-readable, names the blocker (e.g. 'open dispute #…'). */
  readonly reason: string;
}

/**
 * Blocker check seam. Production wires the no-op until the dispute /
 * invoice stories provide real implementations; tests inject blockers to
 * prove the 409 path.
 */
export interface ErasureBlockerChecker {
  findBlockers(args: {
    readonly email: string;
    readonly leadIds: readonly string[];
  }): Promise<readonly ErasureBlocker[]>;
}

export function createNoopBlockerChecker(): ErasureBlockerChecker {
  return { findBlockers: async () => [] };
}

export interface PrivacyService {
  /** Everything Feasly holds about the bearer identity. */
  exportMyData(bearerToken: string | undefined): Promise<PrivacyExportResponse>;
  /** Step 1: record the erasure request, return the consequences statement. */
  requestErasure(
    bearerToken: string | undefined,
  ): Promise<ErasureRequestResponse>;
  /** Step 2: human-confirmed execution of a pending erasure request. */
  confirmErasure(
    bearerToken: string | undefined,
    requestId: string,
  ): Promise<ErasureConfirmResponse>;
}

export interface PrivacyServiceDeps {
  readonly magicLinks: MagicLinkStore;
  readonly leads: LeadStore;
  readonly estimates: EstimateStore;
  readonly privacy: PrivacyStore;
  /** #520: waitlist signups are personal data — exported and erased too. */
  readonly waitlist: WaitlistStore;
  /** #639: callback requests (name/phone) are exported and erased too. */
  readonly callbacks: CallbackRequestStore;
  readonly blockers: ErasureBlockerChecker;
  /** #806: sends the erase-confirmation link. */
  readonly email: Pick<EmailService, 'sendErasureConfirmation'>;
  /** e.g. https://feasly.ca — from config, never hardcoded. */
  readonly appBaseUrl: string;
  /** #806: lifetime of the emailed confirm link (short). */
  readonly confirmLinkTtlSeconds: number;
  /**
   * #806: minimum ms between confirmation emails to one address (reuses the
   * magic-link reissue cooldown setting). Used for the in-memory default
   * when `resendCooldown` is not wired.
   */
  readonly resendCooldownMs: number;
  /** #806: hourly per-address send cap (reuses MAGIC_LINK_MAX_SENDS_PER_HOUR). */
  readonly maxSendsPerHour: number;
  /** Cross-instance cooldown (Postgres-backed in production). */
  readonly resendCooldown?: SharedCooldown;
  /**
   * Cross-instance hourly send budget. Production shares the
   * 'magic-link:send' scope, so erase emails and reissue emails draw on one
   * per-address budget.
   */
  readonly sendBudget?: AnyRateLimiter;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
}

/** SHA-256 hex of the normalized email — the PII-free identity key. */
export function hashEmail(normalizedEmail: string): string {
  return createHash('sha256').update(normalizedEmail, 'utf8').digest('hex');
}

interface AuthContext {
  readonly leadId: string;
  readonly email: string;
  readonly name: string;
  readonly sandbox: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPrivacyService(deps: PrivacyServiceDeps): PrivacyService {
  const clock = deps.clock ?? (() => new Date());

  /**
   * Resolve the bearer token to an identity. Denial reasons are uniform
   * (unknown / expired / revoked / detached all look identical) so the
   * endpoint is not an oracle for token enumeration.
   *
   * #805: only OWNER links authenticate. A partner-share link points its
   * lead_id at the OWNER's lead, so accepting it would let a partner export
   * or erase the owner's data. Non-owner purposes are denied exactly like an
   * unknown token (same 401, same denied audit row) — no purpose oracle.
   */
  async function authenticate(
    bearerToken: string | undefined,
    auditAction: 'export.denied' | 'erase.request.denied' | 'erase.confirm.denied',
  ): Promise<AuthContext> {
    const denied = new HttpError(
      401,
      ErrorCodes.UNAUTHENTICATED,
      'A valid bearer token is required.',
      false,
    );
    if (!bearerToken) {
      await deps.privacy.audit({ leadId: null, action: auditAction });
      throw denied;
    }
    let link;
    try {
      link = await deps.magicLinks.findByToken(bearerToken);
    } catch (error) {
      throw new Error('magic link lookup failed', { cause: error });
    }
    const now = clock();
    if (
      !link ||
      !link.leadId ||
      link.purpose !== OWNER_LINK_PURPOSE ||
      link.revokedAt ||
      link.expiresAt <= now
    ) {
      await deps.privacy.audit({ leadId: null, action: auditAction });
      throw denied;
    }
    let lead;
    try {
      lead = await deps.leads.findById(link.leadId);
    } catch (error) {
      throw new Error('lead lookup failed', { cause: error });
    }
    if (!lead) {
      await deps.privacy.audit({ leadId: null, action: auditAction });
      throw denied;
    }
    return {
      leadId: lead.id,
      email: lead.email,
      name: lead.name,
      sandbox: lead.sandbox,
    };
  }

  const resendCooldown: SharedCooldown =
    deps.resendCooldown ??
    createInMemoryCooldown(deps.resendCooldownMs, () => clock().getTime());
  const sendBudget: AnyRateLimiter =
    deps.sendBudget ??
    createRateLimiter({
      windowMs: MAGIC_LINK_SEND_BUDGET_WINDOW_MS,
      maxRequests: deps.maxSendsPerHour,
      maxTrackedKeys: 10_000,
      clock: () => clock().getTime(),
    });

  /**
   * #806: mint a fresh short-lived owner link and email the confirm URL.
   * Never throws — the erasure request is already recorded, so a send
   * failure answers `confirmationEmailSent: false` and the person can ask
   * again (the duplicate path re-sends once the cooldown has passed).
   * Logs carry reason codes only: never the token, URL, or address.
   */
  async function sendConfirmation(
    auth: AuthContext,
    requestId: string,
  ): Promise<boolean> {
    if (await resendCooldown.isActive(auth.email)) return false;
    if (!(await sendBudget.check(auth.email)).allowed) return false;
    let token: string;
    try {
      const issued = await deps.magicLinks.issue({
        leadId: auth.leadId,
        purpose: OWNER_LINK_PURPOSE,
        ttlSeconds: deps.confirmLinkTtlSeconds,
        clock,
        ...(auth.sandbox ? { sandbox: true } : {}),
      });
      token = issued.token;
    } catch (error) {
      console.error(
        `privacy: erase confirmation link issue failed (${sanitizeErrorMessage(error)})`,
      );
      return false;
    }
    let delivery;
    try {
      delivery = await deps.email.sendErasureConfirmation({
        to: auth.email,
        name: auth.name || undefined,
        confirmUrl: `${deps.appBaseUrl}/privacy/confirm/${encodeURIComponent(requestId)}#token=${encodeURIComponent(token)}`,
        expiresInHours: Math.max(1, Math.ceil(deps.confirmLinkTtlSeconds / 3_600)),
      });
    } catch (error) {
      console.error(
        `privacy: erase confirmation send threw (${sanitizeErrorMessage(error)})`,
      );
      return false;
    }
    if (delivery.sent) {
      await resendCooldown.start(auth.email);
      return true;
    }
    // Accepted but unconfirmed: the provider likely has it — start the
    // cooldown so a retry doesn't duplicate, but report not-sent honestly.
    if (delivery.acceptedByProvider) await resendCooldown.start(auth.email);
    console.warn(`privacy: erase confirmation email not sent (${delivery.emailError})`);
    return false;
  }

  return {
    async exportMyData(bearerToken): Promise<PrivacyExportResponse> {
      const auth = await authenticate(bearerToken, 'export.denied');
      let userLeads;
      try {
        userLeads = await deps.leads.findAllByEmail(auth.email);
      } catch (error) {
        throw new Error('lead lookup failed', { cause: error });
      }
      const leadIds = userLeads.map((l) => l.id);
      const estimateIds = [...new Set(userLeads.map((l) => l.estimateId))];

      let estimates;
      try {
        estimates = await Promise.all(
          estimateIds.map((id) => deps.estimates.findById(id)),
        );
      } catch (error) {
        throw new Error('estimate lookup failed', { cause: error });
      }
      let links;
      try {
        links = await deps.magicLinks.findByLeadIds(leadIds);
      } catch (error) {
        throw new Error('magic link lookup failed', { cause: error });
      }
      let erasureHistory;
      try {
        erasureHistory = await deps.privacy.findAllByEmailHash(
          hashEmail(auth.email),
        );
      } catch (error) {
        throw new Error('erasure history lookup failed', { cause: error });
      }
      let waitlistSignups;
      try {
        waitlistSignups = await deps.waitlist.listByEmail(auth.email);
      } catch (error) {
        throw new Error('waitlist lookup failed', { cause: error });
      }
      let callbacks;
      try {
        callbacks = await deps.callbacks.listByLeadIds(leadIds);
      } catch (error) {
        throw new Error('callback request lookup failed', { cause: error });
      }
      await deps.privacy.audit({ leadId: auth.leadId, action: 'export' });

      return {
        exportedAt: clock().toISOString(),
        email: auth.email,
        leads: userLeads.map((l) => ({
          id: l.id,
          estimateId: l.estimateId,
          addressKey: l.addressKey,
          email: l.email,
          name: l.name,
          phone: l.phone,
          timeline: l.timeline,
          marketingConsent: l.marketingConsent,
          consentTs: l.consentTs.toISOString(),
          tenantKey: l.tenantKey,
          source: l.source,
          createdAt: l.createdAt.toISOString(),
        })),
        estimates: estimates
          .filter((e) => e !== null)
          .map((e) => ({
            id: e.id,
            addressKey: e.addressKey,
            inputs: e.inputs,
            figures: e.figures,
            rows: e.rows,
            costDataVersion: e.costDataVersion,
            createdAt: e.createdAt.toISOString(),
          })),
        // Lifecycle metadata only — the token hash NEVER leaves the server
        // in an export (acceptance criterion 1).
        magicLinks: links.map((m) => ({
          id: m.id,
          leadId: m.leadId,
          purpose: m.purpose,
          createdAt: m.createdAt.toISOString(),
          expiresAt: m.expiresAt.toISOString(),
          usedAt: m.usedAt ? m.usedAt.toISOString() : null,
          revokedAt: m.revokedAt ? m.revokedAt.toISOString() : null,
        })),
        // No server-side store yet (documented in the story) — the shape
        // is frozen now so clients need no breaking change later.
        reportShares: [],
        callbackRequests: callbacks.map((c) => ({
          id: c.id,
          leadId: c.leadId,
          name: c.name,
          phone: c.phone,
          window: c.window,
          status: c.status,
          createdAt: c.createdAt.toISOString(),
        })),
        erasureRequests: erasureHistory.map((r) => ({
          id: r.id,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
        })),
        waitlistSignups: waitlistSignups.map((w) => ({
          topic: w.topic,
          createdAt: w.createdAt.toISOString(),
          consentTs: w.consentTs.toISOString(),
          consentVersion: w.consentVersion,
        })),
        retentionNotice: EXPORT_RETENTION_NOTICE_DRAFT,
      };
    },

    async requestErasure(bearerToken): Promise<ErasureRequestResponse> {
      const auth = await authenticate(bearerToken, 'erase.request.denied');
      const emailHash = hashEmail(auth.email);
      let existing;
      try {
        existing = await deps.privacy.findLatestByEmailHash(emailHash);
      } catch (error) {
        throw new Error('erasure request lookup failed', { cause: error });
      }
      // Idempotent: a pending request is returned as-is, never duplicated.
      // #806: re-sends the confirmation at most once per cooldown.
      if (existing && existing.status === 'requested') {
        const resent = await sendConfirmation(auth, existing.id);
        await deps.privacy.audit({
          leadId: auth.leadId,
          action: 'erase.request',
          detail: `duplicate-suppressed,confirmation-email:${resent ? 'sent' : 'not-sent'}`,
        });
        return {
          requestId: existing.id,
          status: 'requested',
          consequences: ERASURE_CONSEQUENCES_DRAFT.statements,
          createdAt: existing.createdAt.toISOString(),
          confirmationEmailSent: resent,
        };
      }
      let created;
      try {
        created = await deps.privacy.createRequest({
          leadId: auth.leadId,
          emailHash,
        });
      } catch (error) {
        throw new Error('erasure request insert failed', { cause: error });
      }
      const sent = await sendConfirmation(auth, created.id);
      await deps.privacy.audit({
        leadId: auth.leadId,
        action: 'erase.request',
        detail: `confirmation-email:${sent ? 'sent' : 'not-sent'}`,
      });
      return {
        requestId: created.id,
        status: 'requested',
        consequences: ERASURE_CONSEQUENCES_DRAFT.statements,
        createdAt: created.createdAt.toISOString(),
        confirmationEmailSent: sent,
      };
    },

    async confirmErasure(
      bearerToken,
      requestId,
    ): Promise<ErasureConfirmResponse> {
      const auth = await authenticate(bearerToken, 'erase.confirm.denied');
      if (!UUID_RE.test(requestId)) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          'Unknown erasure request.',
          false,
        );
      }
      let request;
      try {
        request = await deps.privacy.findById(requestId);
      } catch (error) {
        throw new Error('erasure request lookup failed', { cause: error });
      }
      if (!request) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          'Unknown erasure request.',
          false,
        );
      }
      // Cross-user: this request belongs to a different identity.
      if (request.emailHash !== hashEmail(auth.email)) {
        await deps.privacy.audit({
          leadId: auth.leadId,
          action: 'erase.confirm.denied',
          detail: 'cross-user-request-id',
        });
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'This erasure request belongs to a different user.',
          false,
        );
      }
      if (request.status === 'completed') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          'This erasure request has already been completed.',
          false,
        );
      }
      let userLeads;
      try {
        userLeads = await deps.leads.findAllByEmail(auth.email);
      } catch (error) {
        throw new Error('lead lookup failed', { cause: error });
      }
      const leadIds = userLeads.map((l) => l.id);
      let blockers;
      try {
        blockers = await deps.blockers.findBlockers({
          email: auth.email,
          leadIds,
        });
      } catch (error) {
        throw new Error('erasure blocker check failed', { cause: error });
      }
      if (blockers.length > 0) {
        const snapshot = blockers.map((b) => ({
          kind: b.kind,
          reason: b.reason,
        }));
        await deps.privacy.markBlocked({ id: request.id, blockers: snapshot });
        await deps.privacy.audit({
          leadId: auth.leadId,
          action: 'erase.blocked',
          detail: `blockers:${blockers.length}`,
        });
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          `Erasure is blocked: ${blockers.map((b) => b.reason).join('; ')}`,
          false,
        );
      }
      // Execution order matters: revoke links BEFORE deleting the leads
      // (the FK is SET NULL — deleting first would orphan the revocation).
      // Not wrapped in a DB transaction (the store surface has none); the
      // steps are retry-safe — re-confirming a half-finished erasure
      // completes it.
      const now = clock();
      let revoked: number;
      try {
        revoked = await deps.magicLinks.revokeByLeadIds(leadIds, now);
      } catch (error) {
        throw new Error('magic link revocation failed', { cause: error });
      }
      // Callback requests reference leads with ON DELETE NO ACTION — they
      // must go first or the lead delete fails on the FK (#639).
      let callbacksDeleted: number;
      try {
        callbacksDeleted = await deps.callbacks.deleteByLeadIds(leadIds);
      } catch (error) {
        throw new Error('callback request deletion failed', { cause: error });
      }
      let deleted: number;
      try {
        deleted = await deps.leads.deleteByEmail(auth.email);
      } catch (error) {
        throw new Error('lead deletion failed', { cause: error });
      }
      let waitlistDeleted: number;
      try {
        waitlistDeleted = await deps.waitlist.deleteByEmail(auth.email);
      } catch (error) {
        throw new Error('waitlist deletion failed', { cause: error });
      }
      let completed;
      try {
        completed = await deps.privacy.markCompleted(request.id, now);
      } catch (error) {
        throw new Error('erasure request completion failed', { cause: error });
      }
      await deps.privacy.audit({
        leadId: auth.leadId,
        action: 'erase.confirm',
        detail: `revoked:${revoked},deleted:${deleted},waitlist:${waitlistDeleted},callbacks:${callbacksDeleted}`,
      });
      return {
        requestId: completed.id,
        status: 'completed',
        confirmedAt: (completed.confirmedAt ?? now).toISOString(),
        revokedMagicLinks: revoked,
        deletedLeads: deleted,
      };
    },
  };
}
