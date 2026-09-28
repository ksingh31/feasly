/**
 * User service (auth/01) — password identity + invitations.
 *
 * The backend foundation for the password-auth track. No routes in this
 * story: auth/02 (admin sign-in) and auth/03 (user management) build the
 * HTTP layer on these methods.
 *
 * Flow:
 * 1. `invite({ email, ... })` — find-or-create the user (status `invited`),
 *    revoke prior pending invitations, mint an opaque token (only its
 *    SHA-256 is stored), email the set-password link.
 * 2. `acceptInvitation(token, { password })` — validate the token + the
 *    password (12 chars min, blocklist), bcrypt the password, flip the
 *    user to `active`, create the builder membership when the invitation
 *    grants one, mark the invitation used.
 * 3. `verifyPassword(email, password)` — credential check for the sign-in
 *    routes. Unknown email, missing password, wrong password, and
 *    non-active status all return null after an identical-cost bcrypt
 *    compare (no enumeration oracle, no timing oracle).
 *
 * Security: password hashes never leave this service — every outward
 * shape is {@link PublicUser} (no hash field exists on it). Raw tokens
 * exist only in the `invite`/`resendInvite` return value (destined for the
 * email) and are never logged. No PII in logs.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type {
  EmailService,
  InvitationEmailInput,
} from './email/email.service';
import { isCommonPassword } from './user-password-blocklist';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPasswordHash,
} from './user-password';

export const STAFF_ROLES = ['super_admin', 'admin', 'viewer'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const BUILDER_ROLES = ['builder_admin', 'builder_member'] as const;
export type BuilderRole = (typeof BUILDER_ROLES)[number];

export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Minimum password length (auth/01) — from the story, not config. */
export const MIN_PASSWORD_LENGTH = 12;

/** Internal record — includes the hash. Never leaves the service. */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly name: string;
  readonly status: UserStatus;
  readonly staffRole: StaffRole | null;
  readonly isProtected: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BuilderMembership {
  readonly builderId: string;
  readonly role: BuilderRole;
  readonly createdAt: Date;
}

/** The outward user shape — there is deliberately no passwordHash field. */
export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly status: UserStatus;
  readonly staffRole: StaffRole | null;
  readonly isProtected: boolean;
  readonly memberships: readonly BuilderMembership[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InvitationRecord {
  readonly id: string;
  readonly email: string;
  readonly staffRole: StaffRole | null;
  readonly builderId: string | null;
  readonly builderRole: BuilderRole | null;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly invitedBy: string | null;
  readonly createdAt: Date;
}

export interface UserStore {
  insert(user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly status: UserStatus;
    readonly staffRole: StaffRole | null;
    readonly isProtected: boolean;
  }): Promise<UserRecord>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /**
   * Set the password hash; flips status invited → active. Also used for
   * password changes (status stays as-is when already active).
   */
  setPasswordHash(
    id: string,
    passwordHash: string,
    now: Date,
  ): Promise<UserRecord>;
  updateUser(
    id: string,
    patch: {
      readonly name?: string;
      readonly staffRole?: StaffRole | null;
      readonly status?: UserStatus;
    },
    now: Date,
  ): Promise<UserRecord>;
  list(limit: number, offset: number): Promise<readonly UserRecord[]>;
}

export interface InvitationStore {
  insert(invitation: {
    readonly id: string;
    readonly email: string;
    readonly staffRole: StaffRole | null;
    readonly builderId: string | null;
    readonly builderRole: BuilderRole | null;
    readonly tokenHash: string;
    readonly expiresAt: Date;
    readonly invitedBy: string | null;
  }): Promise<InvitationRecord>;
  findByTokenHash(tokenHash: string): Promise<InvitationRecord | null>;
  /** Pending = not accepted, not revoked (expiry checked by the caller). */
  findPendingByEmail(email: string): Promise<readonly InvitationRecord[]>;
  markAccepted(id: string, acceptedAt: Date): Promise<void>;
  revokePendingByEmail(email: string, revokedAt: Date): Promise<number>;
}

export interface MembershipStore {
  add(
    userId: string,
    builderId: string,
    role: BuilderRole,
  ): Promise<BuilderMembership>;
  listByUserId(userId: string): Promise<readonly BuilderMembership[]>;
  remove(userId: string, builderId: string): Promise<boolean>;
}

const EmailSchema = z.string().trim().toLowerCase().email().max(254);

function normalizeEmail(email: string): string {
  return EmailSchema.parse(email);
}

const InviteInputSchema = z
  .object({
    email: EmailSchema,
    name: z.string().trim().min(1).max(200),
    staffRole: z.enum(STAFF_ROLES).nullable().optional(),
    builderId: z.string().uuid().nullable().optional(),
    builderRole: z.enum(BUILDER_ROLES).nullable().optional(),
    /** Display name of the builder — for the invite email copy. */
    builderName: z.string().trim().min(1).max(200).nullable().optional(),
    /** Name of the inviter — for the invite email copy. */
    inviterName: z.string().trim().min(1).max(200).nullable().optional(),
    invitedBy: z.string().uuid().nullable().optional(),
  })
  .refine(
    (v) =>
      v.staffRole != null || (v.builderId != null && v.builderRole != null),
    {
      message:
        'An invitation must grant a staff role or a builder membership.',
    },
  )
  .refine(
    (v) =>
      (v.builderId != null) === (v.builderRole != null) ||
      (v.builderId == null && v.builderRole == null),
    { message: 'builderId and builderRole must be provided together.' },
  );

export type InviteInput = z.infer<typeof InviteInputSchema>;

const AcceptInputSchema = z.object({
  password: z.string(),
  name: z.string().trim().min(1).max(200).optional(),
});

export interface UserService {
  /**
   * Invite (or re-invite) a user. Creates the user row when needed,
   * revokes prior pending invitations, mints a fresh token, and emails
   * the set-password link. Returns the raw token exactly once (for the
   * email) — it is never stored or logged.
   */
  invite(input: InviteInput): Promise<{
    readonly user: PublicUser;
    readonly invitationToken: string;
    readonly emailSent: boolean;
  }>;
  /**
   * Mint a fresh invitation for an already-invited user (auth/02's
   * "resend" path and Karan's own first invite).
   */
  resendInvite(
    email: string,
    invitedBy?: { readonly id: string; readonly name?: string },
  ): Promise<{
    readonly user: PublicUser;
    readonly invitationToken: string;
    readonly emailSent: boolean;
  }>;
  /**
   * Accept an invitation: validate the token, set the password, activate
   * the user, grant the builder membership when the invitation carries
   * one. Expired → 401 INVITATION_EXPIRED with the "ask your admin"
   * copy; invalid/revoked → 401 INVITATION_INVALID; already accepted →
   * 409 INVITATION_ACCEPTED.
   */
  acceptInvitation(
    token: string,
    input: { readonly password: string; readonly name?: string },
  ): Promise<PublicUser>;
  /**
   * Credential check for the sign-in routes. Returns the public user on
   * success, null on any failure — unknown email, no password set,
   * wrong password, and non-active status are indistinguishable, and all
   * cost one bcrypt compare.
   */
  verifyPassword(email: string, password: string): Promise<PublicUser | null>;
  /** Throw a 400 with buyer-grade copy when the password is rejected. */
  assertPasswordValid(password: string): void;
  findByEmail(email: string): Promise<PublicUser | null>;
  findById(id: string): Promise<PublicUser | null>;
  listUsers(limit: number, offset: number): Promise<readonly PublicUser[]>;
}

export interface UserServiceDeps {
  readonly users: UserStore;
  readonly invitations: InvitationStore;
  readonly memberships: MembershipStore;
  readonly email: EmailService;
  /** e.g. https://feasly.ca — from config, never hardcoded. */
  readonly appBaseUrl: string;
  /** Invitation link TTL in seconds — from config (7 days). */
  readonly invitationTtlSeconds: number;
  /** bcrypt cost factor — from config. */
  readonly bcryptRounds: number;
  readonly clock?: () => Date;
  /** Log sink for email failures (never the token or the password). */
  readonly onEmailError?: (error: unknown) => void;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function describeAccess(input: {
  readonly staffRole?: StaffRole | null;
  readonly builderRole?: BuilderRole | null;
  readonly builderName?: string | null;
}): string {
  const parts: string[] = [];
  if (input.staffRole === 'super_admin') parts.push('a super admin');
  else if (input.staffRole === 'admin') parts.push('an admin');
  else if (input.staffRole === 'viewer') parts.push('a viewer (read-only)');
  if (input.builderRole != null) {
    const org = input.builderName ?? 'their builder organization';
    parts.push(
      input.builderRole === 'builder_admin'
        ? `an admin for ${org}`
        : `a team member for ${org}`,
    );
  }
  return parts.join(' and ') || 'a team member';
}

export function createUserService(deps: UserServiceDeps): UserService {
  const {
    users,
    invitations,
    memberships,
    email,
    appBaseUrl,
    invitationTtlSeconds,
    bcryptRounds,
    onEmailError,
  } = deps;
  const clock = deps.clock ?? (() => new Date());

  async function toPublic(record: UserRecord): Promise<PublicUser> {
    const ms = await memberships.listByUserId(record.id);
    return {
      id: record.id,
      email: record.email,
      name: record.name,
      status: record.status,
      staffRole: record.staffRole,
      isProtected: record.isProtected,
      memberships: ms,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function assertPasswordValid(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(
        400,
        ErrorCodes.VALIDATION_FAILED,
        `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`,
        false,
      );
    }
    if (isCommonPassword(password)) {
      throw new HttpError(
        400,
        ErrorCodes.VALIDATION_FAILED,
        'That password is too common — try something more unique.',
        false,
      );
    }
  }

  async function sendInviteEmail(args: {
    readonly to: string;
    readonly name: string;
    readonly token: string;
    readonly staffRole: StaffRole | null;
    readonly builderRole: BuilderRole | null;
    readonly builderName: string | null;
    readonly inviterName: string | null;
  }): Promise<boolean> {
    const inviteUrl = `${appBaseUrl}/accept-invite?token=${args.token}`;
    const input: InvitationEmailInput = {
      to: args.to,
      name: args.name,
      inviteUrl,
      expiresInDays: Math.round(invitationTtlSeconds / 86_400),
      accessDescription: describeAccess(args),
      inviterName: args.inviterName ?? undefined,
    };
    try {
      const result = await email.sendInvitation(input);
      return result.sent;
    } catch (error) {
      onEmailError?.(error);
      return false;
    }
  }

  async function mintInvitation(args: {
    readonly email: string;
    readonly name: string;
    readonly staffRole: StaffRole | null;
    readonly builderId: string | null;
    readonly builderRole: BuilderRole | null;
    readonly builderName: string | null;
    readonly inviterName: string | null;
    readonly invitedBy: string | null;
  }): Promise<{ readonly token: string; readonly emailSent: boolean }> {
    const now = clock();
    await invitations.revokePendingByEmail(args.email, now);
    const token = randomBytes(32).toString('hex');
    await invitations.insert({
      id: randomUUID(),
      email: args.email,
      staffRole: args.staffRole,
      builderId: args.builderId,
      builderRole: args.builderRole,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + invitationTtlSeconds * 1000),
      invitedBy: args.invitedBy,
    });
    const emailSent = await sendInviteEmail({
      to: args.email,
      name: args.name,
      token,
      staffRole: args.staffRole,
      builderRole: args.builderRole,
      builderName: args.builderName,
      inviterName: args.inviterName,
    });
    return { token, emailSent };
  }

  return {
    assertPasswordValid,

    async invite(rawInput: InviteInput) {
      const input = InviteInputSchema.parse(rawInput);
      const now = clock();
      const staffRole = input.staffRole ?? null;
      const builderId = input.builderId ?? null;
      const builderRole = input.builderRole ?? null;

      let record = await users.findByEmail(input.email);
      if (record) {
        if (record.status === 'active') {
          throw new HttpError(
            409,
            ErrorCodes.CONFLICT,
            'This person already has an account — no invitation needed.',
            false,
          );
        }
        if (record.status === 'disabled') {
          throw new HttpError(
            409,
            ErrorCodes.CONFLICT,
            'This account has been deactivated — reactivate it instead of inviting.',
            false,
          );
        }
        if (record.isProtected) {
          throw new HttpError(
            403,
            ErrorCodes.FORBIDDEN,
            'This account is managed by the system and cannot be re-invited.',
            false,
          );
        }
        record = await users.updateUser(
          record.id,
          { name: input.name, staffRole },
          now,
        );
      } else {
        record = await users.insert({
          id: randomUUID(),
          email: input.email,
          name: input.name,
          status: 'invited',
          staffRole,
          isProtected: false,
        });
      }

      const { token, emailSent } = await mintInvitation({
        email: record.email,
        name: record.name,
        staffRole,
        builderId,
        builderRole,
        builderName: input.builderName ?? null,
        inviterName: input.inviterName ?? null,
        invitedBy: input.invitedBy ?? null,
      });
      return { user: await toPublic(record), invitationToken: token, emailSent };
    },

    async resendInvite(rawEmail: string, invitedBy) {
      const emailAddr = normalizeEmail(rawEmail);
      const record = await users.findByEmail(emailAddr);
      if (!record || record.status !== 'invited') {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          'No pending invitation for this email.',
          false,
        );
      }
      if (record.isProtected) {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'This account is managed by the system.',
          false,
        );
      }
      const pending = await invitations.findPendingByEmail(emailAddr);
      const latest = pending[0] ?? null;
      const { token, emailSent } = await mintInvitation({
        email: record.email,
        name: record.name,
        staffRole: latest?.staffRole ?? record.staffRole,
        builderId: latest?.builderId ?? null,
        builderRole: latest?.builderRole ?? null,
        builderName: null,
        inviterName: invitedBy?.name ?? null,
        invitedBy: invitedBy?.id ?? null,
      });
      return { user: await toPublic(record), invitationToken: token, emailSent };
    },

    async acceptInvitation(token: string, rawInput) {
      const input = AcceptInputSchema.parse(rawInput);
      const now = clock();
      const invitation = await invitations.findByTokenHash(hashToken(token));
      if (!invitation || invitation.revokedAt !== null) {
        throw new HttpError(
          401,
          ErrorCodes.INVITATION_INVALID,
          "This invitation link isn't valid. Ask your admin for a new invite.",
          false,
        );
      }
      if (invitation.acceptedAt !== null) {
        throw new HttpError(
          409,
          ErrorCodes.INVITATION_ACCEPTED,
          'This invitation was already used — try signing in instead.',
          false,
        );
      }
      if (invitation.expiresAt.getTime() <= now.getTime()) {
        throw new HttpError(
          401,
          ErrorCodes.INVITATION_EXPIRED,
          'This invitation link has expired. Ask your admin for a new invite.',
          false,
        );
      }
      assertPasswordValid(input.password);

      const record = await users.findByEmail(invitation.email);
      if (!record) {
        throw new HttpError(
          500,
          ErrorCodes.INTERNAL_ERROR,
          'Invitation is missing its user account.',
          false,
        );
      }
      if (record.status === 'disabled') {
        throw new HttpError(
          403,
          ErrorCodes.FORBIDDEN,
          'This account has been deactivated.',
          false,
        );
      }
      const passwordHash = await hashPassword(input.password, bcryptRounds);
      const updated = await users.setPasswordHash(record.id, passwordHash, now);
      if (input.name !== undefined && input.name !== updated.name) {
        await users.updateUser(record.id, { name: input.name }, now);
      }
      if (invitation.builderId !== null && invitation.builderRole !== null) {
        await memberships.add(
          record.id,
          invitation.builderId,
          invitation.builderRole,
        );
      }
      await invitations.markAccepted(invitation.id, now);
      const fresh = await users.findById(record.id);
      if (!fresh) {
        throw new HttpError(
          500,
          ErrorCodes.INTERNAL_ERROR,
          'User account disappeared during invitation acceptance.',
          false,
        );
      }
      return toPublic(fresh);
    },

    async verifyPassword(rawEmail: string, password: string) {
      let record: UserRecord | null = null;
      try {
        record = await users.findByEmail(normalizeEmail(rawEmail));
      } catch {
        record = null;
      }
      const candidate =
        record !== null &&
        record.status === 'active' &&
        record.passwordHash !== null
          ? record.passwordHash
          : DUMMY_PASSWORD_HASH;
      const match = await verifyPasswordHash(password, candidate);
      if (!match || record === null || record.status !== 'active') {
        return null;
      }
      return toPublic(record);
    },

    async findByEmail(rawEmail: string) {
      const record = await users.findByEmail(normalizeEmail(rawEmail));
      return record ? toPublic(record) : null;
    },

    async findById(id: string) {
      const record = await users.findById(id);
      return record ? toPublic(record) : null;
    },

    async listUsers(limit: number, offset: number) {
      const records = await users.list(limit, offset);
      return Promise.all(records.map((r) => toPublic(r)));
    },
  };
}
