/**
 * Admin auth service (auth/02).
 *
 * Session auth for the admin area — no passwords anywhere, no magic links
 * (the legacy admin magic-link flow was retired 2026-09-28, Karan).
 * Sessions are minted by the Entra callback service; this service owns
 * session lifecycle:
 *
 * 1. `logout(sessionToken)` — revokes the session.
 * 2. `validateSession(sessionToken)` — for the AdminGuard; returns the
 *    admin email or null.
 * 3. `isSessionExpired(sessionToken)` — distinguishes "expired" from
 *    "invalid" so the frontend can show the specific expiry copy.
 *
 * Security: only SHA-256 hashes of tokens are stored. Raw tokens exist only
 * in the issuance return value (destined for the cookie) and are never
 * logged. No PII in logs.
 */
import { createHash } from 'node:crypto';
import type {
  AdminAuthLogoutResponse,
  AdminAuthMeResponse,
} from '@feasly/contracts';
import type { EntraSignInConfig } from '../config';
import type { AdminAuditStore } from './admin-audit.store';

export interface ViewAsState {
  /** View-as target: exactly one of these is set. */
  readonly builderId?: string;
  readonly userId?: string;
}

export interface AdminSessionRecord {
  readonly id: string;
  readonly email: string;
  /** SHA-256 hex — never the raw token. */
  readonly sessionTokenHash: string;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  /**
   * auth/02: the user this session belongs to. Null for magic-link-era
   * sessions; always set for Entra sign-in sessions.
   */
  readonly userId: string | null;
  /**
   * auth/04: the session's active builder tenant (server-side org choice).
   * Tenant scoping reads this — never a client-supplied id.
   */
  readonly activeBuilderId: string | null;
  /**
   * auth/04: view-as state (`{ builderId }` or `{ userId }`), or null.
   * While set, effective permissions + scoping resolve to the target's.
   */
  readonly viewAs: ViewAsState | null;
}

export interface AdminSessionStore {
  insert(session: {
    readonly id: string;
    readonly email: string;
    readonly sessionTokenHash: string;
    readonly expiresAt: Date;
    /**
     * auth/02: the user this session belongs to. Null/omitted for
     * magic-link-era sessions; always set for Entra sign-in sessions.
     */
    readonly userId?: string | null;
    /**
     * auth/04: initial active builder tenant (sign-in default: the user's
     * first membership). The org switcher changes it via `updateState`.
     */
    readonly activeBuilderId?: string | null;
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
  /**
   * auth/04: update the session's server-side state (active builder choice,
   * view-as). Only the listed fields may change — never the identity.
   */
  updateState(
    sessionTokenHash: string,
    patch: {
      readonly activeBuilderId?: string | null;
      readonly viewAs?: ViewAsState | null;
    },
  ): Promise<void>;
}

/**
 * Admin allowlist store contract. The magic-link flow that consumed it
 * was retired 2026-09-28; the store + table remain for the upcoming
 * user-management stories (AUTH-04 area).
 */
export interface AdminAllowlistStore {
  isAllowlisted(email: string): Promise<boolean>;
  add(email: string, addedBy: string): Promise<void>;
  remove(email: string): Promise<boolean>;
}

export interface AdminAuthService {
  /** POST /api/v1/admin/auth/logout — revokes the session. */
  logout(sessionToken: string | null): Promise<{
    readonly loggedOut: true;
    /**
     * Entra end-session endpoint, or null when Entra is unprovisioned.
     * The frontend navigates here (full page) after logout so the IdP
     * session dies too — otherwise the next "Sign in" silently
     * re-authenticates via the surviving Entra cookie (Karan, 2026-09-28).
     */
    readonly entraLogoutUrl: string | null;
  }>;
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
  readonly sessions: AdminSessionStore;
  readonly audit: AdminAuditStore;
  /**
   * Entra sign-in wiring (tenant values). Only `configured` and
   * `logoutEndpoint` are read — the service never embeds URL literals.
   */
  readonly entraSignIn: Pick<EntraSignInConfig, 'configured' | 'logoutEndpoint'>;
  readonly clock?: () => Date;
}

/** SHA-256 hex — the only form in which session tokens are stored/compared. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createAdminAuthService(
  deps: AdminAuthServiceDeps,
): AdminAuthService {
  const { sessions, audit, entraSignIn, clock = () => new Date() } = deps;

  return {
    async logout(
      sessionToken: string | null,
    ): Promise<{ readonly loggedOut: true; readonly entraLogoutUrl: string | null }> {
      if (sessionToken) {
        await sessions.revokeByHash(hashSessionToken(sessionToken), clock());
        await audit.log({
          actorEmail: null,
          action: 'session_revoked',
          detail: 'admin_logout',
        });
      }
      return {
        loggedOut: true,
        entraLogoutUrl: entraSignIn.configured ? entraSignIn.logoutEndpoint : null,
      };
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
