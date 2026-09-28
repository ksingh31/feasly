/**
 * User service tests (auth/01).
 *
 * Covers the full invite → email → accept → verify lifecycle plus the
 * security properties: token hashing, password policy, no-hash leakage,
 * no-oracle verifyPassword, and invitation expiry/revocation/replay.
 * Stores are in-memory fakes — the Drizzle implementations get their own
 * PGlite tests in user.store.test.ts.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createUserService,
  type BuilderRole,
  type InvitationRecord,
  type InvitationStore,
  type MembershipStore,
  type PublicUser,
  type StaffRole,
  type UserRecord,
  type UserService,
  type UserStatus,
  type UserStore,
} from '../src/services/user.service';
import type {
  EmailDelivery,
  EmailService,
  InvitationEmailInput,
} from '../src/services/email/email.service';
import { ErrorCodes, HttpError } from '../src/middleware/errors';

const NOW = new Date('2026-09-28T00:00:00Z');
const APP_BASE_URL = 'https://feasly.example';
const TTL_SECONDS = 604_800;
const BCRYPT_ROUNDS = 4; // fast for tests; production uses config (10)
const BUILDER_ID = '11111111-1111-4111-8111-111111111111';
const BUILDER_ID_2 = '22222222-2222-4222-8222-222222222222';

function makeUserStore() {
  const records = new Map<string, UserRecord>();
  let counter = 0;
  const store: UserStore & { records: Map<string, UserRecord> } = {
    records,
    insert: async (user) => {
      const record: UserRecord = {
        ...user,
        passwordHash: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      records.set(record.id, record);
      return record;
    },
    findByEmail: async (email) => {
      for (const r of records.values()) if (r.email === email) return r;
      return null;
    },
    findById: async (id) => records.get(id) ?? null,
    setPasswordHash: async (id, passwordHash, now) => {
      const existing = records.get(id);
      if (!existing) throw new Error(`user not found: ${id}`);
      const updated: UserRecord = {
        ...existing,
        passwordHash,
        status: existing.status === 'invited' ? 'active' : existing.status,
        updatedAt: now,
      };
      records.set(id, updated);
      return updated;
    },
    updateUser: async (id, patch, now) => {
      const existing = records.get(id);
      if (!existing) throw new Error(`user not found: ${id}`);
      const updated: UserRecord = { ...existing, ...patch, updatedAt: now };
      records.set(id, updated);
      return updated;
    },
    list: async (limit, offset) =>
      [...records.values()].slice(offset, offset + limit),
  };
  void counter;
  return store;
}

function makeInvitationStore() {
  const records = new Map<string, InvitationRecord>();
  const store: InvitationStore & { records: Map<string, InvitationRecord> } = {
    records,
    insert: async (inv) => {
      const record: InvitationRecord = {
        ...inv,
        acceptedAt: null,
        revokedAt: null,
        createdAt: NOW,
      };
      records.set(record.id, record);
      return record;
    },
    findByTokenHash: async (tokenHash) => {
      for (const r of records.values())
        if (r.tokenHash === tokenHash) return r;
      return null;
    },
    findPendingByEmail: async (email) =>
      [...records.values()]
        .filter(
          (r) =>
            r.email === email && r.acceptedAt === null && r.revokedAt === null,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    markAccepted: async (id, acceptedAt) => {
      const r = records.get(id);
      if (r) records.set(id, { ...r, acceptedAt });
    },
    revokePendingByEmail: async (email, revokedAt) => {
      let n = 0;
      for (const [id, r] of records) {
        if (r.email === email && r.acceptedAt === null && r.revokedAt === null) {
          records.set(id, { ...r, revokedAt });
          n++;
        }
      }
      return n;
    },
  };
  return store;
}

function makeMembershipStore() {
  const rows: { userId: string; builderId: string; role: BuilderRole }[] = [];
  const store: MembershipStore = {
    add: async (userId, builderId, role) => {
      const existing = rows.find(
        (r) => r.userId === userId && r.builderId === builderId,
      );
      if (existing) {
        return { builderId, role: existing.role, createdAt: NOW };
      }
      rows.push({ userId, builderId, role });
      return { builderId, role, createdAt: NOW };
    },
    listByUserId: async (userId) =>
      rows
        .filter((r) => r.userId === userId)
        .map((r) => ({ builderId: r.builderId, role: r.role, createdAt: NOW })),
    remove: async (userId, builderId) => {
      const idx = rows.findIndex(
        (r) => r.userId === userId && r.builderId === builderId,
      );
      if (idx === -1) return false;
      rows.splice(idx, 1);
      return true;
    },
  };
  return store;
}

function makeEmail(opts?: { fail?: boolean }) {
  const sends: InvitationEmailInput[] = [];
  const ok: EmailDelivery = { sent: true, provider: 'log' };
  const email: EmailService & { sends: InvitationEmailInput[] } = {
    sends,
    sendMagicLink: async () => ok,
    sendInvitation: async (input) => {
      if (opts?.fail) throw new Error('smtp exploded');
      sends.push(input);
      return ok;
    },
    sendPartnerShare: async () => ok,
    sendCallbackConfirmation: async () => ok,
    sendNudge: async () => ok,
    sendOpsAlert: async () => ok,
  };
  return email;
}

interface Harness {
  service: UserService;
  users: ReturnType<typeof makeUserStore>;
  invitations: ReturnType<typeof makeInvitationStore>;
  memberships: ReturnType<typeof makeMembershipStore>;
  email: ReturnType<typeof makeEmail>;
  onEmailError: ReturnType<typeof vi.fn>;
}

function harness(opts?: { emailFail?: boolean }): Harness {
  const users = makeUserStore();
  const invitations = makeInvitationStore();
  const memberships = makeMembershipStore();
  const email = makeEmail({ fail: opts?.emailFail });
  const onEmailError = vi.fn();
  const service = createUserService({
    users,
    invitations,
    memberships,
    email,
    appBaseUrl: APP_BASE_URL,
    invitationTtlSeconds: TTL_SECONDS,
    bcryptRounds: BCRYPT_ROUNDS,
    clock: () => NOW,
    onEmailError,
  });
  return { service, users, invitations, memberships, email, onEmailError };
}

const ADMIN_INVITE = {
  email: 'Admin@Example.com', // mixed case — must normalize
  name: 'Ada Admin',
  staffRole: 'admin' as StaffRole,
};

const GOOD_PASSWORD = 'correct horse battery staple!';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    const http = error as HttpError;
    expect(http.status).toBe(status);
    expect(http.code).toBe(code);
    return http;
  }
  throw new Error(`expected HttpError ${status}/${code}, but it resolved`);
}

describe('invite', () => {
  it('creates an invited user, mints a token, and emails the set-password link', async () => {
    const h = harness();
    const { user, invitationToken, emailSent } =
      await h.service.invite(ADMIN_INVITE);

    expect(emailSent).toBe(true);
    expect(user.email).toBe('admin@example.com'); // normalized
    expect(user.status).toBe('invited');
    expect(user.staffRole).toBe('admin');
    expect(user.isProtected).toBe(false);
    // The raw token is returned exactly once; only its hash is stored.
    expect(invitationToken).toMatch(/^[0-9a-f]{64}$/);
    const stored = [...h.invitations.records.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).toBe(sha256Hex(invitationToken));
    expect(stored[0]!.tokenHash).not.toBe(invitationToken);
    expect(stored[0]!.expiresAt.getTime()).toBe(
      NOW.getTime() + TTL_SECONDS * 1000,
    );
    // The email links the token.
    expect(h.email.sends).toHaveLength(1);
    const sent = h.email.sends[0]!;
    expect(sent.to).toBe('admin@example.com');
    expect(sent.inviteUrl).toBe(
      `${APP_BASE_URL}/accept-invite?token=${invitationToken}`,
    );
    expect(sent.expiresInDays).toBe(7);
  });

  it('rejects inviting someone who already has an active account', async () => {
    const h = harness();
    const first = await h.service.invite(ADMIN_INVITE);
    await h.service.acceptInvitation(first.invitationToken, {
      password: GOOD_PASSWORD,
    });
    const err = await expectHttpError(
      h.service.invite({ ...ADMIN_INVITE, name: 'Again' }),
      409,
      ErrorCodes.CONFLICT,
    );
    expect(err.message).toContain('already has an account');
  });

  it('refuses to re-invite the protected system account', async () => {
    const h = harness();
    const seeded = await h.users.insert({
      id: 'protected-id',
      email: 'karanbirsingh667@gmail.com',
      name: 'Karan',
      status: 'invited',
      staffRole: 'super_admin',
      isProtected: true,
    });
    void seeded;
    await expectHttpError(
      h.service.invite({
        email: 'karanbirsingh667@gmail.com',
        name: 'Karan',
        staffRole: 'super_admin',
      }),
      403,
      ErrorCodes.FORBIDDEN,
    );
  });

  it('still creates the invitation when the email send fails', async () => {
    const h = harness({ emailFail: true });
    const { user, invitationToken, emailSent } =
      await h.service.invite(ADMIN_INVITE);
    expect(emailSent).toBe(false);
    expect(user.status).toBe('invited');
    expect(invitationToken).toMatch(/^[0-9a-f]{64}$/);
    expect(h.onEmailError).toHaveBeenCalledTimes(1);
  });

  it('requires a staff role or a builder grant', async () => {
    const h = harness();
    await expect(h.service.invite({ email: 'x@example.com', name: 'X' })).rejects.toThrow();
  });
});

describe('resendInvite', () => {
  it('revokes the old invitation and mints a fresh token', async () => {
    const h = harness();
    const first = await h.service.invite(ADMIN_INVITE);
    const second = await h.service.resendInvite('admin@example.com');
    expect(second.invitationToken).not.toBe(first.invitationToken);
    const pending = await h.invitations.findPendingByEmail('admin@example.com');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.tokenHash).toBe(sha256Hex(second.invitationToken));
    // The old token no longer works.
    await expectHttpError(
      h.service.acceptInvitation(first.invitationToken, {
        password: GOOD_PASSWORD,
      }),
      401,
      ErrorCodes.INVITATION_INVALID,
    );
  });

  it('404s when there is no pending invitation', async () => {
    const h = harness();
    await expectHttpError(
      h.service.resendInvite('nobody@example.com'),
      404,
      ErrorCodes.NOT_FOUND,
    );
  });
});

describe('acceptInvitation', () => {
  it('runs the full lifecycle: accept → active → verify password', async () => {
    const h = harness();
    const { invitationToken, user } = await h.service.invite(ADMIN_INVITE);
    expect(user.status).toBe('invited');

    const accepted = await h.service.acceptInvitation(invitationToken, {
      password: GOOD_PASSWORD,
      name: 'Ada A.',
    });
    expect(accepted.status).toBe('active');
    expect(accepted.name).toBe('Ada A.');
    // No hash on the outward shape — not even as a key.
    expect('passwordHash' in accepted).toBe(false);
    expect(JSON.stringify(accepted)).not.toContain('$2b$');

    // The stored hash is a real bcrypt hash, not the password.
    const stored = await h.users.findByEmail('admin@example.com');
    expect(stored!.passwordHash).toMatch(/^\$2b\$0?4\$/);
    expect(stored!.passwordHash).not.toContain(GOOD_PASSWORD);

    // The invitation is consumed.
    const inv = [...h.invitations.records.values()][0]!;
    expect(inv.acceptedAt).toEqual(NOW);

    // And the password verifies.
    const verified = await h.service.verifyPassword(
      'admin@example.com',
      GOOD_PASSWORD,
    );
    expect(verified?.id).toBe(accepted.id);
    expect('passwordHash' in (verified as object)).toBe(false);
  });

  it('creates the builder membership when the invitation grants one', async () => {
    const h = harness();
    const { invitationToken } = await h.service.invite({
      email: 'builder@example.com',
      name: 'Bob Builder',
      builderId: BUILDER_ID,
      builderRole: 'builder_admin',
      builderName: 'Elite Craft Builders',
    });
    const accepted = await h.service.acceptInvitation(invitationToken, {
      password: GOOD_PASSWORD,
    });
    expect(accepted.memberships).toHaveLength(1);
    expect(accepted.memberships[0]).toMatchObject({
      builderId: BUILDER_ID,
      role: 'builder_admin',
    });
    // A second builder can be added later — multi-builder works.
    await h.memberships.add(accepted.id, BUILDER_ID_2, 'builder_member');
    const reloaded = await h.service.findById(accepted.id);
    expect(reloaded!.memberships).toHaveLength(2);
  });

  it('rejects an unknown token without echoing it', async () => {
    const h = harness();
    await h.service.invite(ADMIN_INVITE);
    const err = await expectHttpError(
      h.service.acceptInvitation('0'.repeat(64), { password: GOOD_PASSWORD }),
      401,
      ErrorCodes.INVITATION_INVALID,
    );
    expect(err.message).not.toContain('0'.repeat(64));
    expect(err.message).toContain('Ask your admin for a new invite');
  });

  it('rejects an expired invitation with the exact clear message', async () => {
    const h = harness();
    const { invitationToken } = await h.service.invite(ADMIN_INVITE);
    // Expire it behind the service's back.
    const inv = [...h.invitations.records.values()][0]!;
    h.invitations.records.set(inv.id, {
      ...inv,
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    const err = await expectHttpError(
      h.service.acceptInvitation(invitationToken, { password: GOOD_PASSWORD }),
      401,
      ErrorCodes.INVITATION_EXPIRED,
    );
    expect(err.message).toBe(
      'This invitation link has expired. Ask your admin for a new invite.',
    );
  });

  it('rejects a replayed (already-accepted) invitation', async () => {
    const h = harness();
    const { invitationToken } = await h.service.invite(ADMIN_INVITE);
    await h.service.acceptInvitation(invitationToken, {
      password: GOOD_PASSWORD,
    });
    const err = await expectHttpError(
      h.service.acceptInvitation(invitationToken, {
        password: 'another valid password!!',
      }),
      409,
      ErrorCodes.INVITATION_ACCEPTED,
    );
    expect(err.message).toContain('try signing in instead');
  });

  it('rejects a revoked invitation', async () => {
    const h = harness();
    const { invitationToken } = await h.service.invite(ADMIN_INVITE);
    const inv = [...h.invitations.records.values()][0]!;
    h.invitations.records.set(inv.id, { ...inv, revokedAt: NOW });
    await expectHttpError(
      h.service.acceptInvitation(invitationToken, { password: GOOD_PASSWORD }),
      401,
      ErrorCodes.INVITATION_INVALID,
    );
  });

  it('enforces the 12-character minimum with buyer-grade copy', async () => {
    const h = harness();
    const { invitationToken } = await h.service.invite(ADMIN_INVITE);
    const err = await expectHttpError(
      h.service.acceptInvitation(invitationToken, { password: 'short1!' }),
      400,
      ErrorCodes.VALIDATION_FAILED,
    );
    expect(err.message).toBe('Use at least 12 characters for your password.');
  });

  it.each(['password123', 'Password123', 'feasly2026', 'FEASLY2026'])(
    'rejects the common password %j',
    async (password) => {
      const h = harness();
      const { invitationToken } = await h.service.invite(ADMIN_INVITE);
      const err = await expectHttpError(
        h.service.acceptInvitation(invitationToken, { password }),
        400,
        ErrorCodes.VALIDATION_FAILED,
      );
      expect(err.message).toContain('too common');
    },
  );
});

describe('verifyPassword', () => {
  it('returns null for wrong password and unknown email alike (no oracle)', async () => {
    const h = harness();
    const { invitationToken } = await h.service.invite(ADMIN_INVITE);
    await h.service.acceptInvitation(invitationToken, {
      password: GOOD_PASSWORD,
    });

    const wrong = await h.service.verifyPassword(
      'admin@example.com',
      'wrong password here!!',
    );
    const unknown = await h.service.verifyPassword(
      'nobody@example.com',
      'wrong password here!!',
    );
    const malformed = await h.service.verifyPassword('not-an-email', 'x');
    expect(wrong).toBeNull();
    expect(unknown).toBeNull();
    expect(malformed).toBeNull();
  });

  it('returns null for a user with no password set and for disabled users', async () => {
    const h = harness();
    await h.service.invite(ADMIN_INVITE); // invited, no password yet
    expect(
      await h.service.verifyPassword('admin@example.com', GOOD_PASSWORD),
    ).toBeNull();

    const { invitationToken } = await h.service.resendInvite(
      'admin@example.com',
    );
    await h.service.acceptInvitation(invitationToken, {
      password: GOOD_PASSWORD,
    });
    const user = await h.users.findByEmail('admin@example.com');
    await h.users.updateUser(user!.id, { status: 'disabled' }, NOW);
    expect(
      await h.service.verifyPassword('admin@example.com', GOOD_PASSWORD),
    ).toBeNull();
  });

  it('succeeds with the right password and carries memberships', async () => {
    const h = harness();
    const { invitationToken } = await h.service.invite({
      email: 'builder@example.com',
      name: 'Bob',
      builderId: BUILDER_ID,
      builderRole: 'builder_member',
    });
    await h.service.acceptInvitation(invitationToken, {
      password: GOOD_PASSWORD,
    });
    const verified = await h.service.verifyPassword(
      'builder@example.com',
      GOOD_PASSWORD,
    );
    expect(verified).not.toBeNull();
    expect(verified!.staffRole).toBeNull();
    expect(verified!.memberships[0]).toMatchObject({
      builderId: BUILDER_ID,
      role: 'builder_member',
    });
  });
});

describe('assertPasswordValid', () => {
  it('accepts a strong password and rejects weak ones directly', () => {
    const h = harness();
    expect(() =>
      h.service.assertPasswordValid('a strong passphrase 123!'),
    ).not.toThrow();
    expect(() => h.service.assertPasswordValid('tiny')).toThrow(
      /at least 12 characters/,
    );
    expect(() => h.service.assertPasswordValid('password123')).toThrow(
      /too common/,
    );
  });
});

describe('finders', () => {
  it('findByEmail/findById/listUsers return public shapes without hashes', async () => {
    const h = harness();
    const { user } = await h.service.invite(ADMIN_INVITE);
    for (const found of [
      await h.service.findByEmail('ADMIN@example.com'),
      await h.service.findById(user.id),
      (await h.service.listUsers(10, 0))[0],
    ]) {
      expect(found).not.toBeNull();
      expect('passwordHash' in (found as object)).toBe(false);
    }
    expect(await h.service.findByEmail('missing@example.com')).toBeNull();
  });
});

describe('invitation email input', () => {
  it('describes a builder grant for the email copy', async () => {
    const h = harness();
    await h.service.invite({
      email: 'builder@example.com',
      name: 'Bob',
      builderId: BUILDER_ID,
      builderRole: 'builder_member',
      builderName: 'Elite Craft Builders',
      inviterName: 'Karan',
    });
    const sent = h.email.sends[0]!;
    expect(sent.accessDescription).toBe(
      'a team member for Elite Craft Builders',
    );
    expect(sent.inviterName).toBe('Karan');
  });

  it('describes a staff grant for the email copy', async () => {
    const h = harness();
    await h.service.invite({
      email: 'viewer@example.com',
      name: 'Vera',
      staffRole: 'viewer',
    });
    expect(h.email.sends[0]!.accessDescription).toBe('a viewer (read-only)');
  });
});

// Static shape guard: PublicUser must not grow a passwordHash field.
describe('PublicUser shape', () => {
  it('has no passwordHash key in its type', () => {
    const check: keyof PublicUser = 'email';
    void check;
    type HasHash = 'passwordHash' extends keyof PublicUser ? true : false;
    const impossible: HasHash = false;
    expect(impossible).toBe(false);
  });
});
