/**
 * Builder auth service (embed/09).
 *
 * Magic-link + allowlist session auth for the builder portal. Follows the
 * admin/01 pattern exactly, with one addition: sessions are bound to a
 * tenant_key, and every lead read is scoped to that tenant.
 *
 * Flow:
 * 1. `requestMagicLink({ email })` — if the (normalized) email is on the
 *    builder allowlist, mint a `builder`-purpose magic-link token and email
 *    it. Otherwise: identical response, no email, no timing oracle.
 * 2. `verifyMagicLink(token)` — validates the builder token, marks it used,
 *    creates a 7-day session bound to the builder's tenant_key, returns the
 *    opaque session token (the route adapter sets it as an httpOnly cookie).
 * 3. `logout(sessionToken)` — revokes the session.
 * 4. `validateSession(sessionToken)` — for the BuilderGuard; returns the
 *    `{ email, tenantKey }` or null.
 *
 * Security: only SHA-256 hashes of tokens are stored. Raw tokens exist only
 * in the issuance return value (destined for the email/cookie) and are never
 * logged. No PII in logs.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  BuilderAuthLogoutResponse,
  BuilderAuthRequestResponse,
  BuilderAuthVerifyResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { EntraSignInConfig } from '../config';
import type { EmailService } from './email/email.service';
import type { AdminAuditStore } from './admin-audit.store';
import type { BuilderService } from './builder.service';
import { hashMagicToken, type MagicLinkStore } from './magic-link.store';

export interface BuilderSessionRecord {
  readonly id: string;
  readonly email: string;
  readonly tenantKey: string;
  /**
   * auth/04: the session's builder tenant, resolved server-side at
   * sign-in. Tenant scoping reads this, never a request value. Null for
   * legacy rows whose tenant_key has no builder row.
   */
  readonly builderId: string | null;
  /**
   * auth/05: the user this session belongs to. Null for legacy magic-link
   * sessions (no user row).
   */
  readonly userId: string | null;
  /** SHA-256 hex — never the raw token. */
  readonly sessionTokenHash: string;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface BuilderSessionStore {
  insert(session: {
    readonly id: string;
    readonly email: string;
    readonly tenantKey: string;
    readonly builderId: string | null;
    readonly sessionTokenHash: string;
    readonly expiresAt: Date;
    /**
     * auth/05: the user this session belongs to. Set for Entra sessions;
     * null for legacy magic-link sessions (no user row).
     */
    readonly userId?: string | null;
  }): Promise<BuilderSessionRecord>;
  /** Active = not revoked and not expired. */
  findActiveByHash(
    sessionTokenHash: string,
    now: Date,
  ): Promise<BuilderSessionRecord | null>;
  /**
   * Find by hash regardless of expiry (but not revoked). Used to
   * distinguish "expired" from "invalid" for the expiry copy.
   */
  findByHash(sessionTokenHash: string): Promise<BuilderSessionRecord | null>;
  revokeByHash(sessionTokenHash: string, revokedAt: Date): Promise<void>;
  /** Revoke all sessions for an email (allowlist removal). Returns count. */
  revokeByEmail(email: string, revokedAt: Date): Promise<number>;
  /**
   * auth/05: revoke all sessions for a user id — immediate session kill
   * on deactivation. Returns count.
   */
  revokeByUserId(userId: string, revokedAt: Date): Promise<number>;
  /**
   * auth/05: switch the session's active builder (org switcher). The
   * builder id must be one of the user's memberships — the service
   * checks; the store just writes. Returns false when the session hash
   * is unknown.
   */
  updateBuilderId(
    sessionTokenHash: string,
    builderId: string,
  ): Promise<boolean>;
}

export interface BuilderAllowlistStore {
  isAllowlisted(email: string): Promise<boolean>;
  /** Returns the tenant key for an allowlisted email, or null. */
  getTenantKey(email: string): Promise<string | null>;
  add(email: string, tenantKey: string, addedBy: string): Promise<void>;
  remove(email: string): Promise<boolean>;
}

export interface BuilderSession {
  readonly email: string;
  readonly tenantKey: string;
  /**
   * auth/04: the session's builder tenant (server-side, never a request
   * value). Null for legacy sessions.
   */
  readonly builderId: string | null;
}

export interface BuilderAuthService {
  /** POST /api/v1/builder/auth/request — identical response either way. */
  requestMagicLink(body: unknown): Promise<BuilderAuthRequestResponse>;
  /**
   * GET /api/v1/builder/auth/verify — validates the builder magic-link
   * token, creates the session. Returns the raw session token exactly once
   * (the adapter sets it as the httpOnly cookie).
   */
  verifyMagicLink(token: string): Promise<{
    readonly authenticated: true;
    readonly email: string;
    readonly tenantKey: string;
    readonly sessionToken: string;
  }>;
  /** POST /api/v1/builder/auth/logout — revokes the session. */
  logout(sessionToken: string | null): Promise<{
    readonly loggedOut: true;
    /** Entra end-session endpoint, or null when Entra is unprovisioned. */
    readonly entraLogoutUrl: string | null;
  }>;
  /** Guard hook: returns the session identity for a valid session, else null. */
  validateSession(sessionToken: string | null): Promise<BuilderSession | null>;
  /**
   * Returns true if the token matches a session that exists but has expired
   * (vs never-existed/invalid/revoked). Used to show the specific
   * "session expired" copy.
   */
  isSessionExpired(sessionToken: string | null): Promise<boolean>;
}

export interface BuilderAuthServiceDeps {
  readonly allowlist: BuilderAllowlistStore;
  readonly sessions: BuilderSessionStore;
  /**
   * auth/04: resolves the allowlisted tenant_key to the builders row at
   * session creation, so the session carries its builder tenant
   * server-side (never a request value).
   */
  readonly builders: Pick<BuilderService, 'getByTenantKey'>;
  readonly audit: AdminAuditStore;
  readonly magicLinks: MagicLinkStore;
  readonly email: EmailService;
  /** e.g. https://feasly.ca — from config, never hardcoded. */
  readonly appBaseUrl: string;
  /** Magic-link token TTL in seconds — from config. */
  readonly magicLinkTtlSeconds: number;
  /** Builder session TTL in seconds (7 days, same as admin) — from config. */
  readonly builderSessionTtlSeconds: number;
  /**
   * Entra sign-in wiring (shared tenant). Returned on logout so the
   * builder frontend can kill the IdP session once builder Entra lands
   * (AUTH #74); null while Entra is unprovisioned. The frontend ignores
   * it until then — builder sessions are magic-link today, no IdP
   * session exists.
   */
  readonly entraSignIn: Pick<EntraSignInConfig, 'configured' | 'logoutEndpoint'>;
  readonly clock?: () => Date;
  /** Log sink for fire-and-forget email failures (never the token). */
  readonly onEmailError?: (error: unknown) => void;
}

const requestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

/** SHA-256 hex — the only form in which session tokens are stored/compared. */
export function hashBuilderSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Normalize an email for allowlist comparison (lowercase + trim). */
export function normalizeBuilderEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createBuilderAuthService(
  deps: BuilderAuthServiceDeps,
): BuilderAuthService {
  const {
    allowlist,
    sessions,
    audit,
    magicLinks,
    email,
    appBaseUrl,
    magicLinkTtlSeconds,
    builderSessionTtlSeconds,
    clock = () => new Date(),
    onEmailError = () => {},
    builders,
    entraSignIn,
  } = deps;

  return {
    async requestMagicLink(body: unknown): Promise<BuilderAuthRequestResponse> {
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'A valid email address is required.',
          false,
        );
      }
      const emailAddr = normalizeBuilderEmail(parsed.data.email);
      const allowed = await allowlist.isAllowlisted(emailAddr);

      if (allowed) {
        const issued = await magicLinks.issue({
          leadId: null,
          purpose: 'builder',
          email: emailAddr,
          ttlSeconds: magicLinkTtlSeconds,
          clock,
        });
        // Fire-and-forget: the response must not wait on the email send,
        // otherwise the allowlisted path is measurably slower than the
        // denied path (timing oracle). Delivery failures are logged.
        const verifyUrl = `${appBaseUrl}/builder/verify?token=${issued.token}`;
        email
          .sendMagicLink({
            to: emailAddr,
            magicLinkUrl: verifyUrl,
            expiresInDays: Math.max(1, Math.ceil(magicLinkTtlSeconds / 86_400)),
            audience: 'builder',
          })
          .then((delivery) => {
            // The email service never throws on send failure — a failed
            // delivery arrives here as { sent: false }.
            if (!delivery.sent) onEmailError(new Error(delivery.failureReason));
          }, onEmailError);
        await audit.log({
          actorEmail: null,
          action: 'magic_link_requested',
          detail: 'builder',
        });
      }
      // Identical response either way — no enumeration oracle.
      return { sent: true };
    },

    async verifyMagicLink(token: string) {
      const record = await magicLinks.findByToken(token);
      const now = clock();
      if (
        !record ||
        record.purpose !== 'builder' ||
        record.email === null ||
        record.usedAt !== null ||
        record.revokedAt !== null ||
        record.expiresAt.getTime() <= now.getTime()
      ) {
        // Uniform denial — no oracle for token enumeration.
        await audit.log({
          actorEmail: null,
          action: 'auth_failed',
          detail: 'builder_verify_invalid',
        });
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'This sign-in link is invalid or has expired. Request a fresh one.',
          false,
        );
      }
      // Resolve the tenant for this builder email. The email was allowlisted
      // at request time; re-check here so removal between request and verify
      // denies access.
      const tenantKey = await allowlist.getTenantKey(record.email);
      if (!tenantKey) {
        await audit.log({
          actorEmail: null,
          action: 'auth_failed',
          detail: 'builder_verify_not_allowlisted',
        });
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'This sign-in link is invalid or has expired. Request a fresh one.',
          false,
        );
      }
      // Single-use: consume the link. If a concurrent verify already
      // consumed it, deny (replay attempt).
      const consumed = await magicLinks.markUsed(record.id, now);
      if (!consumed) {
        await audit.log({
          actorEmail: null,
          action: 'auth_failed',
          detail: 'builder_verify_replay',
        });
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'This sign-in link has already been used. Request a fresh one.',
          false,
        );
      }
      const sessionToken = randomBytes(32).toString('hex');
      // auth/04: bind the session to the builders row server-side. A
      // missing builder row leaves builderId null — the auth context then
      // grants no tenant scope (fail closed).
      const builder = await builders.getByTenantKey(tenantKey);
      await sessions.insert({
        id: randomUUID(),
        email: record.email,
        tenantKey,
        builderId: builder?.id ?? null,
        sessionTokenHash: hashBuilderSessionToken(sessionToken),
        expiresAt: new Date(now.getTime() + builderSessionTtlSeconds * 1000),
      });
      await audit.log({
        actorEmail: record.email,
        action: 'session_created',
        detail: `builder:${tenantKey}`,
      });
      return {
        authenticated: true as const,
        email: record.email,
        tenantKey,
        sessionToken,
      };
    },

    async logout(
      sessionToken: string | null,
    ): Promise<{ readonly loggedOut: true; readonly entraLogoutUrl: string | null }> {
      if (sessionToken) {
        await sessions.revokeByHash(
          hashBuilderSessionToken(sessionToken),
          clock(),
        );
        await audit.log({
          actorEmail: null,
          action: 'session_revoked',
          detail: 'builder_logout',
        });
      }
      return {
        loggedOut: true,
        entraLogoutUrl: entraSignIn.configured ? entraSignIn.logoutEndpoint : null,
      };
    },

    async validateSession(
      sessionToken: string | null,
    ): Promise<BuilderSession | null> {
      if (!sessionToken) return null;
      const session = await sessions.findActiveByHash(
        hashBuilderSessionToken(sessionToken),
        clock(),
      );
      return session
        ? {
            email: session.email,
            tenantKey: session.tenantKey,
            builderId: session.builderId,
          }
        : null;
    },

    async isSessionExpired(sessionToken: string | null): Promise<boolean> {
      if (!sessionToken) return false;
      const hash = hashBuilderSessionToken(sessionToken);
      // If it's active, it's not expired. If no record exists (or revoked),
      // it's invalid, not expired.
      const active = await sessions.findActiveByHash(hash, clock());
      if (active) return false;
      const record = await sessions.findByHash(hash);
      if (!record) return false;
      return record.expiresAt.getTime() <= clock().getTime();
    },
  };
}

/** Re-exported for tests that assert the stored hash (never the raw token). */
export { hashMagicToken };
