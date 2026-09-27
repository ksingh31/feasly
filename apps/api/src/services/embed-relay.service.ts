/**
 * Embed relay-code exchange service (embed/06).
 *
 * The iframe exchanges the single-use relay code (posted by the builder
 * snippet from `?feasly_rt=`) for a 12-hour in-memory session token via
 * `POST /api/v1/embed/session {code, tenant_key}`.
 *
 * Exchange semantics:
 * - The code is consumed atomically (single-use) by the store.
 * - The presented `tenant_key` must match the code's tenant — mismatch is
 *   a denial, not a fallback.
 * - Expired or already-used codes → 410 with a re-issue affordance
 *   (the frontend shows "session expired" + "Email me a fresh link").
 * - Unknown codes → the same 410 shape (no oracle for code enumeration).
 * - Every attempt (success AND failure) is audit-logged with
 *   `tenant_key`, `code_id`, `ip_hash` and the result. No raw IPs, no
 *   plaintext codes, no PII in the audit trail.
 *
 * The session token is an opaque random string held in a process-local
 * in-memory map (12h TTL). The iframe keeps it in NGXS state (never
 * localStorage, never a cookie — privacy-strict by design) and presents it
 * to load the report. No Set-Cookie is ever emitted.
 */
import { randomBytes } from 'node:crypto';
import type {
  EmbedRelayResendResponse,
  EmbedSessionResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import { hashIp, type EmbedRelayStore } from './embed-relay.store';
import type { LeadStore } from './lead.store';

export interface EmbedRelayService {
  /**
   * Exchange a relay code for a session token. Throws HttpError(410) when
   * the code is unknown, expired, already used, or bound to a different
   * tenant.
   */
  exchange(request: unknown, clientIp: string | undefined): Promise<EmbedSessionResponse>;
  /**
   * Re-issue a fresh relay code for an expired or already-used code.
   * Throws HttpError(410) when the presented code is unknown, still valid,
   * or bound to a different tenant; HttpError(429) when a resend went out
   * for this code inside the cooldown window.
   */
  resend(request: unknown, clientIp: string | undefined): Promise<EmbedRelayResendResponse>;
  /**
   * Validate a session token issued by `exchange`. Returns the bound
   * estimate/lead context, or null when the token is unknown or expired.
   */
  resolveSession(sessionToken: string): Promise<EmbedSessionContext | null>;
}

/** What a valid session token resolves to. */
export interface EmbedSessionContext {
  readonly tenantKey: string;
  readonly estimateId: string | null;
  readonly leadId: string | null;
  readonly userId: string | null;
}

export interface EmbedRelayServiceDeps {
  readonly relayCodes: EmbedRelayStore;
  readonly leads: LeadStore;
  /** Seconds a relay code stays valid — from config, never hardcoded. */
  readonly relayCodeTtlSeconds: number;
  /** Seconds a session token stays valid — from config, never hardcoded. */
  readonly sessionTtlSeconds: number;
  /**
   * Seconds between resends for the same code (embed/06 AC3). From config,
   * never hardcoded.
   */
  readonly relayResendCooldownSeconds: number;
  /** Injected clock for tests; defaults to wall time. */
  readonly clock?: () => Date;
}

interface SessionEntry extends EmbedSessionContext {
  readonly expiresAt: number;
}

/**
 * Process-local session registry. The tokens are opaque bearer credentials
 * with a 12h TTL; they are never persisted (privacy-strict) and never
 * leave the process. A periodic sweep evicts expired entries.
 */
class InMemorySessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  private lastSweep = 0;

  issue(ctx: EmbedSessionContext, ttlSeconds: number, nowMs: number): string {
    this.sweep(nowMs);
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { ...ctx, expiresAt: nowMs + ttlSeconds * 1000 });
    return token;
  }

  resolve(token: string, nowMs: number): EmbedSessionContext | null {
    const entry = this.sessions.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= nowMs) {
      this.sessions.delete(token);
      return null;
    }
    return {
      tenantKey: entry.tenantKey,
      estimateId: entry.estimateId,
      leadId: entry.leadId,
      userId: entry.userId,
    };
  }

  private sweep(nowMs: number): void {
    // Sweep at most once a minute — the map is small and short-lived.
    if (nowMs - this.lastSweep < 60_000) return;
    this.lastSweep = nowMs;
    for (const [token, entry] of this.sessions) {
      if (entry.expiresAt <= nowMs) this.sessions.delete(token);
    }
  }
}

const exchangeRequestSchema = {
  parse(request: unknown): { code: string; tenant_key: string } {
    if (typeof request !== 'object' || request === null) {
      throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Request body must be an object');
    }
    const body = request as Record<string, unknown>;
    const code = body['code'];
    const tenantKey = body['tenant_key'];
    if (typeof code !== 'string' || code.trim() === '') {
      throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Field "code" is required');
    }
    if (typeof tenantKey !== 'string' || tenantKey.trim() === '') {
      throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Field "tenant_key" is required');
    }
    // Codes are 64 hex chars (32 bytes). Reject anything else early so
    // malformed input never reaches the hash lookup.
    if (!/^[0-9a-fA-F]{64}$/.test(code.trim())) {
      throw new HttpError(400, ErrorCodes.VALIDATION_FAILED, 'Field "code" is malformed');
    }
    return { code: code.trim(), tenant_key: tenantKey.trim() };
  },
};

export function createEmbedRelayService(deps: EmbedRelayServiceDeps): EmbedRelayService {
  const { relayCodes, leads } = deps;
  const clock = deps.clock ?? (() => new Date());
  const registry = new InMemorySessionRegistry();

  // 410 with the re-issue affordance. The detail names the affordance for
  // the frontend ("session expired" + "Email me a fresh link") without
  // leaking which of the denial reasons fired.
  const gone = (detail: string): HttpError =>
    new HttpError(410, 'RELAY_CODE_INVALID', detail, false);

  return {
    async exchange(request: unknown, clientIp: string | undefined): Promise<EmbedSessionResponse> {
      const { code, tenant_key } = exchangeRequestSchema.parse(request);
      const ipHash = hashIp(clientIp ?? 'unknown');
      const nowMs = clock().getTime();

      const result = await relayCodes.exchange({ code, ipHash, clock });
      if (!result.ok) {
        const reasonDetail =
          result.reason === 'expired'
            ? 'This link has expired. Request a fresh link to view the report.'
            : 'This link has already been used or is invalid. Request a fresh link to view the report.';
        await relayCodes.audit({
          codeId: null,
          tenantKey: tenant_key,
          ipHash,
          action: 'exchange.denied',
          detail: result.reason,
        });
        throw gone(reasonDetail);
      }

      const record = result.record;
      if (record.tenantKey !== tenant_key) {
        await relayCodes.audit({
          codeId: record.id,
          tenantKey: tenant_key,
          ipHash,
          action: 'exchange.denied',
          detail: 'tenant_mismatch',
        });
        throw gone('This link is not valid for this builder. Request a fresh link to view the report.');
      }

      await relayCodes.audit({
        codeId: record.id,
        tenantKey: record.tenantKey,
        ipHash,
        action: 'exchanged',
        detail: 'ok',
      });

      const ctx: EmbedSessionContext = {
        tenantKey: record.tenantKey,
        estimateId: record.estimateId,
        leadId: record.leadId,
        userId: record.userId,
      };
      const sessionToken = registry.issue(ctx, deps.sessionTtlSeconds, nowMs);

      // leadScore is the only non-identifier the iframe may echo to the
      // parent via FEASLY_AUTH_OK. No PII crosses postMessage — ever.
      let leadScore = 0;
      if (record.leadId !== null) {
        const lead = await leads.findById(record.leadId);
        if (lead !== null) leadScore = lead.leadScore;
      }

      return {
        sessionToken,
        estimateId: record.estimateId ?? '',
        leadScore,
        expiresInSeconds: deps.sessionTtlSeconds,
      };
    },

    async resolveSession(sessionToken: string): Promise<EmbedSessionContext | null> {
      return registry.resolve(sessionToken, clock().getTime());
    },

    /**
     * Re-issue a fresh relay code for an expired or already-used code
     * (embed/06 AC3 — the "session expired" re-issue affordance).
     *
     * The presenter proves prior possession by presenting the old code —
     * the same trust channel the code arrived on — so no PII is needed or
     * accepted. Denials are uniform 410s (no oracle beyond the contract);
     * the 60s-per-code cooldown is a 429. Every attempt is audit-logged.
     */
    async resend(
      request: unknown,
      clientIp: string | undefined,
    ): Promise<EmbedRelayResendResponse> {
      const { code, tenant_key } = exchangeRequestSchema.parse(request);
      const ipHash = hashIp(clientIp ?? 'unknown');
      const now = clock();

      const deny = async (
        codeId: string | null,
        detail: string,
        message: string,
      ): Promise<never> => {
        await relayCodes.audit({
          codeId,
          tenantKey: tenant_key,
          ipHash,
          action: 'relay.resend_denied',
          detail,
        });
        throw gone(message);
      };

      const record = await relayCodes.findByHash(code);
      if (record === null) {
        return deny(null, 'not_found', 'This link is invalid. Start a new estimate to get a fresh link.');
      }
      if (record.tenantKey !== tenant_key) {
        return deny(record.id, 'tenant_mismatch', 'This link is not valid for this builder. Start a new estimate to get a fresh link.');
      }

      const expired = record.expiresAt.getTime() <= now.getTime();
      const used = record.usedAt !== null;
      if (!expired && !used) {
        return deny(
          record.id,
          'still_valid',
          'This link is still valid — open it to view the report.',
        );
      }

      const cooldownStart = new Date(
        now.getTime() - deps.relayResendCooldownSeconds * 1000,
      );
      const recentResends = await relayCodes.countRecentResends(record.id, cooldownStart);
      if (recentResends > 0) {
        await relayCodes.audit({
          codeId: record.id,
          tenantKey: record.tenantKey,
          ipHash,
          action: 'relay.resend_denied',
          detail: 'cooldown',
        });
        throw new HttpError(
          429,
          ErrorCodes.RATE_LIMITED,
          'A fresh link was just issued. Please wait a minute and try again.',
        );
      }

      const issued = await relayCodes.issue({
        tenantKey: record.tenantKey,
        userId: record.userId ?? undefined,
        estimateId: record.estimateId ?? undefined,
        leadId: record.leadId ?? undefined,
        ttlSeconds: deps.relayCodeTtlSeconds,
        clock,
      });
      // Audit against the superseded code's id so the per-code cooldown
      // (countRecentResends(record.id, …)) actually sees this resend.
      await relayCodes.audit({
        codeId: record.id,
        tenantKey: record.tenantKey,
        ipHash,
        action: 'relay.resent',
        detail: `issued=${issued.id}`,
      });

      return { code: issued.code, expiresInSeconds: deps.relayCodeTtlSeconds };
    },
  };
}
