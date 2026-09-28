/**
 * EntraCallbackService (auth/02) — the backend half of Entra sign-in.
 *
 * `POST /api/v1/admin/auth/entra/callback` flow:
 * 1. Zod-validate `{ code, codeVerifier, redirectUri }`.
 * 2. Exchange the code for an id_token (EntraTokenValidator).
 * 3. Validate the id_token (signature, iss, aud, exp).
 * 4. Resolve our user via the typed Drizzle `UserStore`:
 *    - unknown email or `disabled` → 403 with buyer-grade copy — no
 *      enumeration beyond that message;
 *    - row already linked to this Entra object id → returning sign-in;
 *    - `invited` row → `UserService.completeInvitation` links the Entra
 *      object id, accepts the invitation, flips invited → active;
 *    - protected seed row or active-but-never-linked row → link directly
 *      (the user-management API refuses edits on protected rows, so the
 *      seed row can't go through `completeInvitation`).
 *    A token whose object id doesn't match the linked account is rejected —
 *    the Entra identity changed, so this isn't the same sign-in.
 * 5. Mint a 7-day session in `admin_sessions` bound to the user id, reusing
 *    the existing SHA-256 token-hash + httpOnly cookie discipline.
 * 6. Return `{ authenticated, user: { email, name, staffRole }, sessionToken }`
 *    — Entra tokens never leave the backend.
 *
 * Never logs the code, code verifier, or tokens.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AdminEntraCallbackResponse } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminAuditStore } from './admin-audit.store';
import {
  hashSessionToken,
  type AdminSessionStore,
} from './admin-auth.service';
import type { EntraTokenValidator } from './entra-token-validator';
import type {
  PublicUser,
  UserService,
  UserStore,
} from './user.service';

export interface EntraCallbackService {
  /**
   * Handle the PKCE callback. Returns the session identity plus the raw
   * session token exactly once (the adapter sets it as the httpOnly
   * cookie and returns it in the JSON body for the SPA bearer flow).
   * The shape is `AdminEntraCallbackResponse` from `@feasly/contracts`.
   */
  handleCallback(body: unknown): Promise<AdminEntraCallbackResponse>;
}

export interface EntraCallbackServiceDeps {
  readonly tokenValidator: EntraTokenValidator;
  /** Typed Drizzle store — user lookup + direct linking. */
  readonly users: UserStore;
  /** Invitation acceptance + public user shape (with memberships). */
  readonly userService: UserService;
  readonly sessions: AdminSessionStore;
  readonly audit: Pick<AdminAuditStore, 'log'>;
  /** Admin session TTL in seconds (7 days per D-02) — from config. */
  readonly adminSessionTtlSeconds: number;
  readonly clock?: () => Date;
  readonly uuid?: () => string;
}

const callbackBodySchema = z.object({
  code: z.string().trim().min(1).max(10_000),
  codeVerifier: z.string().trim().min(1).max(10_000),
  redirectUri: z.string().trim().min(1).max(2_000),
});

/**
 * Buyer-grade denial for unknown (or disabled) accounts. Identical copy in
 * both cases — no enumeration oracle.
 */
function unknownAccount(): HttpError {
  return new HttpError(
    403,
    ErrorCodes.FORBIDDEN,
    'We couldn\u2019t find your Feasly account — ask your admin for an invite.',
    false,
  );
}

/** Uniform 401 — never reveal which identity check failed (no oracle). */
function signInIncomplete(): HttpError {
  return new HttpError(
    401,
    ErrorCodes.UNAUTHENTICATED,
    'Sign-in didn\u2019t complete — try again.',
    false,
  );
}

export function createEntraCallbackService(
  deps: EntraCallbackServiceDeps,
): EntraCallbackService {
  const {
    tokenValidator,
    users,
    userService,
    sessions,
    audit,
    adminSessionTtlSeconds,
    clock = () => new Date(),
    uuid = randomUUID,
  } = deps;

  /**
   * Effective role for the response. Staff rows report their staff_role;
   * builder-side rows (null staff_role) report their highest membership
   * role. A user with neither gets least-privilege `builder_member` —
   * server-side guards still deny anything they aren't granted.
   */
  function resolveStaffRole(user: PublicUser): string {
    if (user.staffRole) return user.staffRole;
    if (
      user.memberships.some(
        (membership) => membership.role === 'builder_admin',
      )
    ) {
      return 'builder_admin';
    }
    return 'builder_member';
  }

  async function publicUserByEmail(email: string): Promise<PublicUser> {
    const user = await userService.findByEmail(email);
    if (!user) {
      // The row existed a moment ago — fail closed, never invent a user.
      throw unknownAccount();
    }
    return user;
  }

  async function resolveUser(
    entraObjectId: string,
    email: string,
  ): Promise<PublicUser> {
    const record = await users.findByEmail(email);
    if (!record || record.status === 'disabled') {
      await audit.log({
        actorEmail: null,
        action: 'auth_failed',
        detail: 'entra_callback_unknown_user',
      });
      throw unknownAccount();
    }
    if (record.entraObjectId === entraObjectId) {
      // Returning sign-in — this Entra identity is already linked.
      return publicUserByEmail(email);
    }
    if (record.entraObjectId !== null) {
      // The token's Entra identity doesn't match the linked account — the
      // Entra account changed, so this isn't the same sign-in.
      await audit.log({
        actorEmail: record.email,
        action: 'auth_failed',
        detail: 'entra_callback_identity_mismatch',
      });
      throw signInIncomplete();
    }
    // First sign-in — link this Entra identity to the row.
    if (!record.isProtected && record.status === 'invited') {
      try {
        const linked = await userService.completeInvitation(
          email,
          entraObjectId,
        );
        await audit.log({
          actorEmail: linked.email,
          action: 'entra_account_linked',
          detail: 'admin_signin_first',
        });
        return linked;
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          // Invited row but no pending invitation (or a raced delete) —
          // not someone we invited.
          await audit.log({
            actorEmail: null,
            action: 'auth_failed',
            detail: 'entra_callback_unknown_user',
          });
          throw unknownAccount();
        }
        // 401 expired invitation, 403, etc. already carry buyer-grade copy.
        throw error;
      }
    }
    // Protected seed row, or an active row that was never linked: the
    // user-management API refuses edits on protected rows, so link directly
    // instead of going through `completeInvitation`.
    await users.updateUser(
      record.id,
      { status: 'active', entraObjectId },
      clock(),
    );
    await audit.log({
      actorEmail: record.email,
      action: 'entra_account_linked',
      detail: 'admin_signin_first',
    });
    return publicUserByEmail(email);
  }

  return {
    async handleCallback(body: unknown) {
      const parsed = callbackBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Sign-in didn\u2019t complete — try again.',
          false,
        );
      }
      const { code, codeVerifier, redirectUri } = parsed.data;

      const { idToken } = await tokenValidator.exchangeCode({
        code,
        codeVerifier,
        redirectUri,
      });
      const identity = await tokenValidator.validateIdToken(idToken);

      const user = await resolveUser(identity.entraObjectId, identity.email);

      const now = clock();
      const sessionToken = randomBytes(32).toString('hex');
      await sessions.insert({
        id: uuid(),
        email: user.email,
        sessionTokenHash: hashSessionToken(sessionToken),
        userId: user.id,
        // auth/04: sign-in default for the session's active builder — the
        // org switcher can change it later. Tenant scoping reads this.
        activeBuilderId: user.memberships[0]?.builderId ?? null,
        expiresAt: new Date(now.getTime() + adminSessionTtlSeconds * 1000),
      });
      await audit.log({
        actorEmail: user.email,
        action: 'session_created',
        detail: 'entra_callback',
      });

      return {
        authenticated: true as const,
        user: {
          email: user.email,
          name: user.name,
          staffRole: resolveStaffRole(user),
        },
        sessionToken,
      };
    },
  };
}
