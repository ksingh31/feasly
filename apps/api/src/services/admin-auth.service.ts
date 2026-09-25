/**
 * Admin auth service (admin/01).
 *
 * Magic-link + allowlist session auth. No passwords anywhere.
 *
 * Flow:
 * 1. `requestMagicLink({ email })` — if the (normalized) email is on the
 *    allowlist, mint an `admin`-purpose magic-link token and email it.
 *    Otherwise: identical response, no email, no timing oracle (the email
 *    send is fire-and-forget so both paths are DB-bound).
 * 2. `verifyMagicLink(token)` — validates the admin token, marks it used,
 *    creates a 7-day session, returns the opaque session token (the route
 *    adapter sets it as an httpOnly cookie).
 * 3. `logout(sessionToken)` — revokes the session.
 * 4. `validateSession(sessionToken)` — for the AdminGuard; returns the
 *    admin email or null.
 *
 * Security: only SHA-256 hashes of tokens are stored. Raw tokens exist only
 * in the issuance return value (destined for the email/cookie) and are never
 * logged. No PII in logs.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AdminAuthLogoutResponse,
  AdminAuthRequestResponse,
  AdminAuthVerifyResponse,
} from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { EmailService } from './email/email.service';
import type { AdminAuditStore } from './admin-audit.store';
import { hashMagicToken, type MagicLinkStore } from './magic-link.store';

export interface AdminSessionRecord {
  readonly id: string;
  readonly email: string;
  /** SHA-256 hex — never the raw token. */
  readonly sessionTokenHash: string;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface AdminSessionStore {
  insert(session: {
    readonly id: string;
    readonly email: string;
    readonly sessionTokenHash: string;
    readonly expiresAt: Date;
  }): Promise<AdminSessionRecord>;
  /** Active = not revoked and not expired. */
  findActiveByHash(
    sessionTokenHash: string,
    now: Date,
  ): Promise<AdminSessionRecord | null>;
  /**
   * Find by hash regardless of expiry (but not revoked). Used to
   * distinguish "expired" from "invalid" for the expiry copy.
   */
  findByHash(sessionTokenHash: string): Promise<AdminSessionRecord | null>;
  revokeByHash(sessionTokenHash: string, revokedAt: Date): Promise<void>;
  /** Revoke all sessions for an email (allowlist removal). Returns count. */
  revokeByEmail(email: string, revokedAt: Date): Promise<number>;
}

export interface AdminAllowlistStore {
  isAllowlisted(email: string): Promise<boolean>;
  add(email: string, addedBy: string): Promise<void>;
  remove(email: string): Promise<boolean>;
}

export interface AdminAuthService {
  /** POST /api/v1/admin/auth/request — identical response either way. */
  requestMagicLink(body: unknown): Promise<AdminAuthRequestResponse>;
  /**
   * GET /api/v1/admin/auth/verify — validates the admin magic-link token,
   * creates the session. Returns the raw session token exactly once (the
   * adapter sets it as the httpOnly cookie).
   */
  verifyMagicLink(token: string): Promise<{
    readonly authenticated: true;
    readonly email: string;
    readonly sessionToken: string;
  }>;
  /** POST /api/v1/admin/auth/logout — revokes the session. */
  logout(sessionToken: string | null): Promise<{ readonly loggedOut: true }>;
  /** Guard hook: returns the admin email for a valid session, else null. */
  validateSession(sessionToken: string | null): Promise<string | null>;
  /**
   * Returns true if the token matches a session that exists but has expired
   * (vs never-existed/invalid/revoked). Used to show the specific
   * "session expired" copy.
   */
  isSessionExpired(sessionToken: string | null): Promise<boolean>;
}

export interface AdminAuthServiceDeps {
  readonly allowlist: AdminAllowlistStore;
  readonly sessions: AdminSessionStore;
  readonly audit: AdminAuditStore;
  readonly magicLinks: MagicLinkStore;
  readonly email: EmailService;
  /** e.g. https://feasly.ca — from config, never hardcoded. */
  readonly appBaseUrl: string;
  /** Magic-link token TTL in seconds — from config. */
  readonly magicLinkTtlSeconds: number;
  /** Admin session TTL in seconds (7 days per D-02) — from config. */
  readonly adminSessionTtlSeconds: number;
  readonly clock?: () => Date;
  /** Log sink for fire-and-forget email failures (never the token). */
  readonly onEmailError?: (error: unknown) => void;
}

const requestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

/** SHA-256 hex — the only form in which session tokens are stored/compared. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Normalize an email for allowlist comparison (lowercase + trim). */
export function normalizeAdminEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createAdminAuthService(
  deps: AdminAuthServiceDeps,
): AdminAuthService {
  const {
    allowlist,
    sessions,
    audit,
    magicLinks,
    email,
    appBaseUrl,
    magicLinkTtlSeconds,
    adminSessionTtlSeconds,
    clock = () => new Date(),
    onEmailError = () => {},
  } = deps;

  return {
    async requestMagicLink(body: unknown): Promise<AdminAuthRequestResponse> {
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'A valid email address is required.',
          false,
        );
      }
      const emailAddr = normalizeAdminEmail(parsed.data.email);
      const allowed = await allowlist.isAllowlisted(emailAddr);

      if (allowed) {
        const issued = await magicLinks.issue({
          leadId: null,
          purpose: 'admin',
          email: emailAddr,
          ttlSeconds: magicLinkTtlSeconds,
          clock,
        });
        // Fire-and-forget: the response must not wait on the email send,
        // otherwise the allowlisted path is measurably slower than the
        // denied path (timing oracle). Delivery failures are logged.
        const verifyUrl = `${appBaseUrl}/admin/verify?token=${issued.token}`;
        email
          .sendMagicLink({
            to: emailAddr,
            magicLinkUrl: verifyUrl,
            expiresInDays: Math.max(1, Math.ceil(magicLinkTtlSeconds / 86_400)),
            audience: 'admin',
          })
          .catch(onEmailError);
        await audit.log({
          actorEmail: null,
          action: 'magic_link_requested',
          detail: 'admin',
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
        record.purpose !== 'admin' ||
        record.email === null ||
        record.usedAt !== null ||
        record.revokedAt !== null ||
        record.expiresAt.getTime() <= now.getTime()
      ) {
        // Uniform denial — no oracle for token enumeration.
        await audit.log({
          actorEmail: null,
          action: 'auth_failed',
          detail: 'admin_verify_invalid',
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
          detail: 'admin_verify_replay',
        });
        throw new HttpError(
          401,
          ErrorCodes.UNAUTHENTICATED,
          'This sign-in link has already been used. Request a fresh one.',
          false,
        );
      }
      const sessionToken = randomBytes(32).toString('hex');
      await sessions.insert({
        id: randomUUID(),
        email: record.email,
        sessionTokenHash: hashSessionToken(sessionToken),
        expiresAt: new Date(now.getTime() + adminSessionTtlSeconds * 1000),
      });
      await audit.log({
        actorEmail: record.email,
        action: 'session_created',
        detail: 'admin',
      });
      return {
        authenticated: true as const,
        email: record.email,
        sessionToken,
      };
    },

    async logout(
      sessionToken: string | null,
    ): Promise<{ readonly loggedOut: true }> {
      if (sessionToken) {
        await sessions.revokeByHash(hashSessionToken(sessionToken), clock());
        await audit.log({
          actorEmail: null,
          action: 'session_revoked',
          detail: 'admin_logout',
        });
      }
      return { loggedOut: true };
    },

    async validateSession(sessionToken: string | null): Promise<string | null> {
      if (!sessionToken) return null;
      const session = await sessions.findActiveByHash(
        hashSessionToken(sessionToken),
        clock(),
      );
      return session ? session.email : null;
    },

    async isSessionExpired(sessionToken: string | null): Promise<boolean> {
      if (!sessionToken) return false;
      const hash = hashSessionToken(sessionToken);
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
