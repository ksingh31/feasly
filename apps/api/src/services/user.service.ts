/**
 * UserService (auth/01 — Entra pivot) — admin user lifecycle.
 *
 * Karan's decision (2026-09-27): Feasly stores NO passwords. Microsoft
 * Entra External ID owns the credential; we keep only the Entra object id
 * on the user row. There are no login/password endpoints here — that is
 * #71. This service owns:
 *
 *   invite            admin invites → Graph create-user → invitation row →
 *                     branded email linking to /admin/login
 *   resendInvite      re-issue a pending invitation (retries Graph if the
 *                     first create failed)
 *   revokeInvitation  withdraw a pending invitation (disables the Entra
 *                     account first — access must actually stop)
 *   disableUser / enableUser   staff lifecycle (protected-account guarded)
 *   completeInvitation  #71 calls this on first sign-in: links the Entra
 *                     object id, flips invited → active, accepts the invite
 *
 * Thin by design: all DB access goes through the injected stores, all
 * Entra access through EntraUserService, all mail through EmailService.
 * The public user shape never carries the Entra object id.
 */
import { randomUUID } from 'node:crypto';
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { AdminAuditStore } from './admin-audit.store';
import type { EmailService } from './email';
import type { EntraUserService } from './entra-user.service';

export type UserStatus = 'invited' | 'active' | 'disabled';
export type StaffRole = 'super_admin' | 'admin' | 'viewer';
export type BuilderRole = 'builder_admin' | 'builder_member';
export type InvitationStatus = 'pending' | 'accepted' | 'revoked';

export const STAFF_ROLES: readonly StaffRole[] = [
  'super_admin',
  'admin',
  'viewer',
];
export const BUILDER_ROLES: readonly BuilderRole[] = [
  'builder_admin',
  'builder_member',
];

/** The one account the API refuses to edit or delete. */
export const PROTECTED_EMAIL = 'karanbirsingh667@gmail.com';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly status: UserStatus;
  readonly staffRole: StaffRole | null;
  readonly entraObjectId: string | null;
  readonly isProtected: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BuilderMembership {
  readonly builderId: string;
  readonly role: BuilderRole;
  readonly createdAt: Date;
}

/** The only user shape that leaves this service — no Entra ids. */
export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly status: UserStatus;
  readonly staffRole: StaffRole | null;
  readonly isProtected: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly memberships: readonly BuilderMembership[];
}

export interface InvitationRecord {
  readonly id: string;
  readonly email: string;
  readonly invitedBy: string | null;
  readonly role: StaffRole | BuilderRole;
  readonly builderId: string | null;
  readonly entraUserId: string | null;
  readonly status: InvitationStatus;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface InviteInput {
  readonly email: string;
  readonly name: string;
  readonly role: StaffRole | BuilderRole;
  /** Builder grant — when set, `role` must be a builder role. */
  readonly builderId?: string | null;
  /** Inviting user id (for the invited_by column). */
  readonly invitedBy?: string | null;
  readonly inviterName?: string;
  /** For the audit trail. */
  readonly actorEmail?: string | null;
}

export interface UserStore {
  insert(user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly status: UserStatus;
    readonly staffRole: StaffRole | null;
    readonly entraObjectId: string | null;
    readonly isProtected: boolean;
  }): Promise<UserRecord>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  updateUser(
    id: string,
    patch: {
      readonly name?: string;
      readonly status?: UserStatus;
      readonly staffRole?: StaffRole | null;
      readonly entraObjectId?: string | null;
    },
    now: Date,
  ): Promise<UserRecord>;
  list(limit: number, offset: number): Promise<UserRecord[]>;
}

export interface InvitationStore {
  insert(invitation: {
    readonly id: string;
    readonly email: string;
    readonly invitedBy: string | null;
    readonly role: StaffRole | BuilderRole;
    readonly builderId: string | null;
    readonly entraUserId: string | null;
    readonly status: InvitationStatus;
    readonly expiresAt: Date;
  }): Promise<InvitationRecord>;
  findPendingByEmail(email: string): Promise<InvitationRecord[]>;
  findLatestByEmail(email: string): Promise<InvitationRecord | null>;
  markStatus(id: string, status: InvitationStatus): Promise<void>;
  revokePendingByEmail(email: string): Promise<number>;
}

export interface MembershipStore {
  add(
    userId: string,
    builderId: string,
    role: BuilderRole,
  ): Promise<BuilderMembership>;
  listByUserId(userId: string): Promise<BuilderMembership[]>;
  remove(userId: string, builderId: string): Promise<boolean>;
}

export interface UserServiceDeps {
  readonly users: UserStore;
  readonly invitations: InvitationStore;
  readonly memberships: MembershipStore;
  readonly entra: EntraUserService;
  readonly email: Pick<EmailService, 'sendInvitation'>;
  readonly audit: AdminAuditStore;
  readonly clock?: () => Date;
  readonly uuid?: () => string;
  readonly invitationTtlSeconds?: number;
  readonly appBaseUrl: string;
}

export interface UserService {
  invite(input: InviteInput): Promise<{ user: PublicUser; emailSent: boolean }>;
  resendInvite(
    email: string,
    opts?: {
      readonly invitedBy?: string | null;
      readonly inviterName?: string;
      readonly actorEmail?: string | null;
    },
  ): Promise<{ user: PublicUser; emailSent: boolean }>;
  revokeInvitation(email: string, actorEmail?: string | null): Promise<void>;
  disableUser(id: string, actorEmail?: string | null): Promise<PublicUser>;
  enableUser(id: string, actorEmail?: string | null): Promise<PublicUser>;
  /** #71: first sign-in — link the Entra account, accept the invitation. */
  completeInvitation(
    email: string,
    entraObjectId: string,
  ): Promise<PublicUser>;
  findByEmail(email: string): Promise<PublicUser | null>;
  findById(id: string): Promise<PublicUser | null>;
  listUsers(limit?: number, offset?: number): Promise<PublicUser[]>;
}

/** Lowercased, trimmed — the unique identity (allowlist discipline). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isStaffRole(role: string): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

function isBuilderRole(role: string): role is BuilderRole {
  return (BUILDER_ROLES as readonly string[]).includes(role);
}

function toPublicUser(
  user: UserRecord,
  memberships: readonly BuilderMembership[],
): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    staffRole: user.staffRole,
    isProtected: user.isProtected,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    memberships,
  };
}

function validateEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      'That email address doesn\u2019t look right — check it for typos and try again.',
    );
  }
}

function validateInviteInput(input: InviteInput): {
  email: string;
  builderId: string | null;
} {
  const email = normalizeEmail(input.email);
  validateEmail(email);
  const name = input.name.trim();
  if (name.length === 0 || name.length > 200) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      'Give the invitee a name (up to 200 characters).',
    );
  }
  if (!isStaffRole(input.role) && !isBuilderRole(input.role)) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      `Unknown role "${input.role}".`,
    );
  }
  const builderId = input.builderId ?? null;
  if (builderId && !isBuilderRole(input.role)) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      'A builder invitation needs a builder role (builder_admin or builder_member).',
    );
  }
  if (!builderId && !isStaffRole(input.role)) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      'A staff invitation needs a staff role (super_admin, admin, or viewer).',
    );
  }
  return { email, builderId };
}

function rejectProtected(user: UserRecord): void {
  if (user.isProtected) {
    throw new HttpError(
      403,
      ErrorCodes.PROTECTED_ACCOUNT,
      'This account is protected and can\u2019t be changed here.',
    );
  }
}

export function createUserService(deps: UserServiceDeps): UserService {
  const {
    users,
    invitations,
    memberships,
    entra,
    email: emailService,
    audit,
    appBaseUrl,
  } = deps;
  const clock = deps.clock ?? (() => new Date());
  const uuid = deps.uuid ?? randomUUID;
  const invitationTtlSeconds = deps.invitationTtlSeconds ?? 604_800;

  async function publicUser(user: UserRecord): Promise<PublicUser> {
    return toPublicUser(user, await memberships.listByUserId(user.id));
  }

  async function sendInviteEmail(args: {
    user: UserRecord;
    name: string;
    role: StaffRole | BuilderRole;
    builderId: string | null;
    inviterName?: string;
  }): Promise<boolean> {
    const accessDescription = args.builderId
      ? `Builder access to the Feasly portal as ${args.role === 'builder_admin' ? 'a builder admin' : 'a builder team member'}`
      : `Admin access to the Feasly dashboard as ${args.role.replace('_', ' ')}`;
    const delivery = await emailService.sendInvitation({
      to: args.user.email,
      name: args.name,
      signInUrl: `${appBaseUrl}/admin/login`,
      expiresInDays: Math.round(invitationTtlSeconds / 86_400),
      accessDescription,
      inviterName: args.inviterName,
    });
    return delivery.sent;
  }

  async function insertInvitation(args: {
    email: string;
    invitedBy: string | null;
    role: StaffRole | BuilderRole;
    builderId: string | null;
    entraUserId: string | null;
    now: Date;
  }): Promise<InvitationRecord> {
    return invitations.insert({
      id: uuid(),
      email: args.email,
      invitedBy: args.invitedBy,
      role: args.role,
      builderId: args.builderId,
      entraUserId: args.entraUserId,
      status: 'pending',
      expiresAt: new Date(args.now.getTime() + invitationTtlSeconds * 1000),
    });
  }

  async function createEntraAccount(
    email: string,
    name: string,
  ): Promise<string> {
    // Graph owns the credential from here on. Failures surface as 502 so
    // the admin knows the sign-in account was NOT created — the user row
    // stays (status invited) and resendInvite retries Graph.
    const created = await entra.createExternalUser({
      email,
      displayName: name,
    });
    return created.id;
  }

  return {
    async invite(input) {
      const { email, builderId } = validateInviteInput(input);
      const name = input.name.trim();
      const now = clock();
      const existing = await users.findByEmail(email);
      if (existing) {
        rejectProtected(existing);
        if (existing.status === 'active') {
          throw new HttpError(
            409,
            ErrorCodes.CONFLICT,
            'This person already has access — no need to invite them again.',
          );
        }
        if (existing.status === 'disabled') {
          throw new HttpError(
            409,
            ErrorCodes.CONFLICT,
            'This account is disabled — re-enable it instead of inviting again.',
          );
        }
      }

      const user = existing
        ? await users.updateUser(
            existing.id,
            {
              name,
              staffRole: isStaffRole(input.role)
                ? input.role
                : existing.staffRole,
            },
            now,
          )
        : await users.insert({
            id: uuid(),
            email,
            name,
            status: 'invited',
            staffRole: isStaffRole(input.role) ? input.role : null,
            entraObjectId: null,
            isProtected: false,
          });

      if (builderId) {
        await memberships.add(user.id, builderId, input.role as BuilderRole);
      }

      // Idempotency: if a pending invitation already carries a Graph account
      // (e.g. the first invite's DB write failed after Graph succeeded),
      // reuse it instead of creating a duplicate Entra account.
      const pendingInvites = await invitations.findPendingByEmail(email);
      const entraUserId =
        pendingInvites.find((i) => i.entraUserId)?.entraUserId ??
        (await createEntraAccount(email, name));

      await invitations.revokePendingByEmail(email);
      await insertInvitation({
        email,
        invitedBy: input.invitedBy ?? null,
        role: input.role,
        builderId,
        entraUserId,
        now,
      });

      const emailSent = await sendInviteEmail({
        user,
        name,
        role: input.role,
        builderId,
        inviterName: input.inviterName,
      });

      await audit.log({
        actorEmail: input.actorEmail ?? null,
        action: 'user.invited',
        detail: `email=${email} role=${input.role}`,
      });
      return { user: await publicUser(user), emailSent };
    },

    async resendInvite(email, opts) {
      const normalized = normalizeEmail(email);
      validateEmail(normalized);
      const now = clock();
      const user = await users.findByEmail(normalized);
      if (!user) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          'No user found for that email — invite them first.',
        );
      }
      rejectProtected(user);
      if (user.status === 'active') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          'This person already has access — no need to invite them again.',
        );
      }
      if (user.status === 'disabled') {
        throw new HttpError(
          409,
          ErrorCodes.CONFLICT,
          'This account is disabled — re-enable it instead of inviting again.',
        );
      }
      const latest = await invitations.findLatestByEmail(normalized);
      if (!latest) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          'No invitation found for that email — invite them first.',
        );
      }
      // If the first Graph create failed, retry it now.
      const entraUserId =
        latest.entraUserId ??
        (await createEntraAccount(normalized, user.name));
      await invitations.revokePendingByEmail(normalized);
      await insertInvitation({
        email: normalized,
        invitedBy: opts?.invitedBy ?? latest.invitedBy,
        role: latest.role,
        builderId: latest.builderId,
        entraUserId,
        now,
      });
      const emailSent = await sendInviteEmail({
        user,
        name: user.name,
        role: latest.role,
        builderId: latest.builderId,
        inviterName: opts?.inviterName,
      });
      await audit.log({
        actorEmail: opts?.actorEmail ?? null,
        action: 'user.invitation_resent',
        detail: `email=${normalized}`,
      });
      return { user: await publicUser(user), emailSent };
    },

    async revokeInvitation(email, actorEmail) {
      const normalized = normalizeEmail(email);
      validateEmail(normalized);
      const pending = await invitations.findPendingByEmail(normalized);
      if (pending.length === 0) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          'No pending invitation for that email.',
        );
      }
      // Disable the Entra account FIRST: if Graph fails the admin must know
      // access may still be live, so nothing changes locally on failure.
      for (const invitation of pending) {
        if (invitation.entraUserId) {
          await entra.setAccountEnabled(invitation.entraUserId, false);
        }
      }
      await invitations.revokePendingByEmail(normalized);
      await audit.log({
        actorEmail: actorEmail ?? null,
        action: 'user.invitation_revoked',
        detail: `email=${normalized}`,
      });
    },

    async disableUser(id, actorEmail) {
      const user = await users.findById(id);
      if (!user) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'User not found.');
      }
      rejectProtected(user);
      if (user.status === 'disabled') {
        return publicUser(user);
      }
      if (user.entraObjectId) {
        await entra.setAccountEnabled(user.entraObjectId, false);
      }
      const updated = await users.updateUser(
        id,
        { status: 'disabled' },
        clock(),
      );
      await audit.log({
        actorEmail: actorEmail ?? null,
        action: 'user.disabled',
        detail: `email=${user.email}`,
      });
      return publicUser(updated);
    },

    async enableUser(id, actorEmail) {
      const user = await users.findById(id);
      if (!user) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'User not found.');
      }
      rejectProtected(user);
      if (user.entraObjectId) {
        await entra.setAccountEnabled(user.entraObjectId, true);
      }
      const updated = await users.updateUser(
        id,
        { status: user.status === 'disabled' ? 'active' : user.status },
        clock(),
      );
      await audit.log({
        actorEmail: actorEmail ?? null,
        action: 'user.enabled',
        detail: `email=${user.email}`,
      });
      return publicUser(updated);
    },

    async completeInvitation(email, entraObjectId) {
      const normalized = normalizeEmail(email);
      validateEmail(normalized);
      const now = clock();
      const user = await users.findByEmail(normalized);
      if (!user) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'User not found.');
      }
      rejectProtected(user);
      const pending = await invitations.findPendingByEmail(normalized);
      if (pending.length === 0) {
        throw new HttpError(
          404,
          ErrorCodes.NOT_FOUND,
          'No pending invitation for that email.',
        );
      }
      const latest = pending[0]!;
      if (latest.expiresAt.getTime() <= now.getTime()) {
        throw new HttpError(
          401,
          ErrorCodes.INVITATION_EXPIRED,
          'This invitation link has expired. Ask your admin for a new invite.',
        );
      }
      await invitations.markStatus(latest.id, 'accepted');
      for (const stale of pending.slice(1)) {
        await invitations.markStatus(stale.id, 'revoked');
      }
      const updated = await users.updateUser(
        user.id,
        { status: 'active', entraObjectId },
        now,
      );
      await audit.log({
        actorEmail: null,
        action: 'user.invitation_accepted',
        detail: `email=${normalized}`,
      });
      return publicUser(updated);
    },

    async findByEmail(email) {
      const user = await users.findByEmail(normalizeEmail(email));
      return user ? publicUser(user) : null;
    },

    async findById(id) {
      const user = await users.findById(id);
      return user ? publicUser(user) : null;
    },

    async listUsers(limit = 50, offset = 0) {
      const rows = await users.list(limit, offset);
      return Promise.all(rows.map((row) => publicUser(row)));
    },
  };
}
