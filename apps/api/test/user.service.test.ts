/**
 * UserService tests (auth/01 — Entra pivot).
 *
 * Graph is mocked at the EntraUserService boundary; the stores are
 * in-memory. Covers: invite → email → completeInvitation lifecycle, Graph
 * failure handling, resend/revoke, protected-account guards, and that the
 * public user shape never carries the Entra object id.
 */
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/middleware/errors';
import {
  createUserService,
  type BuilderMembership,
  type InvitationRecord,
  type InvitationStore,
  type MembershipStore,
  type UserRecord,
  type UserService,
  type UserServiceDeps,
  type UserStore,
} from '../src/services/user.service';
import type { InvitationEmailInput } from '../src/services/email/email.service';
import type { EntraUserService } from '../src/services/entra-user.service';

interface EntraCall {
  readonly op: 'create' | 'setEnabled' | 'delete';
  readonly email?: string;
  readonly displayName?: string;
  readonly id?: string;
  readonly enabled?: boolean;
}

interface Harness {
  service: UserService;
  entraCalls: EntraCall[];
  sentEmails: InvitationEmailInput[];
  auditLog: { action: string; actorEmail: string | null; detail?: string }[];
  invitations: InvitationRecord[];
  failGraphCreate: boolean;
  failGraphToggle: boolean;
  seedUser: UserStore['insert'];
}

function makeHarness(): Harness {
  const userRows = new Map<string, UserRecord>();
  const membershipRows = new Map<string, BuilderMembership[]>();
  let uuidCounter = 0;
  const now = new Date('2026-09-27T18:00:00Z');

  const h: Harness = {
    service: null as unknown as UserService,
    entraCalls: [],
    sentEmails: [],
    auditLog: [],
    invitations: [],
    failGraphCreate: false,
    failGraphToggle: false,
    seedUser: null as unknown as UserStore['insert'],
  };

  const users: UserStore = {
    async insert(user) {
      const record: UserRecord = { ...user, createdAt: now, updatedAt: now };
      userRows.set(record.id, record);
      return record;
    },
    async findByEmail(email) {
      for (const row of userRows.values()) {
        if (row.email === email) return row;
      }
      return null;
    },
    async findById(id) {
      return userRows.get(id) ?? null;
    },
    async updateUser(id, patch, at) {
      const row = userRows.get(id);
      if (!row) throw new Error(`user not found: ${id}`);
      const updated: UserRecord = { ...row, ...patch, updatedAt: at };
      userRows.set(id, updated);
      return updated;
    },
    async list(limit, offset) {
      return [...userRows.values()].slice(offset, offset + limit);
    },
  };
  h.seedUser = users.insert.bind(users);

  const invitations: InvitationStore = {
    async insert(invitation) {
      const record: InvitationRecord = { ...invitation, createdAt: now };
      h.invitations.push(record);
      return record;
    },
    async findPendingByEmail(email) {
      return h.invitations
        .filter((i) => i.email === email && i.status === 'pending')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    async findLatestByEmail(email) {
      const rows = h.invitations
        .filter((i) => i.email === email)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows[0] ?? null;
    },
    async markStatus(id, status) {
      const row = h.invitations.find((i) => i.id === id);
      if (!row) throw new Error(`invitation not found: ${id}`);
      (row as { status: string }).status = status;
    },
    async revokePendingByEmail(email) {
      let count = 0;
      for (const row of h.invitations) {
        if (row.email === email && row.status === 'pending') {
          (row as { status: string }).status = 'revoked';
          count++;
        }
      }
      return count;
    },
  };

  const memberships: MembershipStore = {
    async add(userId, builderId, role) {
      const list = membershipRows.get(userId) ?? [];
      const existing = list.find((m) => m.builderId === builderId);
      if (existing) return existing;
      const created: BuilderMembership = { builderId, role, createdAt: now };
      membershipRows.set(userId, [...list, created]);
      return created;
    },
    async listByUserId(userId) {
      return membershipRows.get(userId) ?? [];
    },
    async remove(userId, builderId) {
      const list = membershipRows.get(userId) ?? [];
      const next = list.filter((m) => m.builderId !== builderId);
      membershipRows.set(userId, next);
      return next.length !== list.length;
    },
  };

  const entra: EntraUserService = {
    configured: true,
    async createExternalUser(input) {
      if (h.failGraphCreate) {
        throw new HttpError(
          502,
          'DEPENDENCY_UNAVAILABLE',
          'We couldn\u2019t reach the sign-in service. Try again in a moment.',
          true,
        );
      }
      h.entraCalls.push({
        op: 'create',
        email: input.email,
        displayName: input.displayName,
      });
      return { id: `entra-${input.email}` };
    },
    async setAccountEnabled(id, enabled) {
      if (h.failGraphToggle) {
        throw new HttpError(
          502,
          'DEPENDENCY_UNAVAILABLE',
          'The sign-in service couldn\u2019t complete that request.',
          true,
        );
      }
      h.entraCalls.push({ op: 'setEnabled', id, enabled });
    },
    async deleteUser(id) {
      h.entraCalls.push({ op: 'delete', id });
    },
  };

  const deps: UserServiceDeps = {
    users,
    invitations,
    memberships,
    entra,
    email: {
      sendInvitation: async (input: InvitationEmailInput) => {
        h.sentEmails.push(input);
        return { sent: true, provider: 'log' };
      },
    },
    audit: {
      async append(entry) {
        h.auditLog.push(entry);
        return {
          id: 'audit-1',
          actorEmail: entry.actorEmail,
          action: entry.action,
          detail: entry.detail ?? null,
          createdAt: now,
        };
      },
      async log(entry) {
        h.auditLog.push(entry);
      },
      async recent() {
        return [];
      },
    },
    clock: () => now,
    uuid: () => `uuid-${++uuidCounter}`,
    invitationTtlSeconds: 604_800,
    appBaseUrl: 'https://app.example',
  };
  h.service = createUserService(deps);
  return h;
}

async function seedProtected(h: Harness): Promise<void> {
  await h.seedUser({
    id: 'protected-1',
    email: 'karanbirsingh667@gmail.com',
    name: 'Karan',
    status: 'invited',
    staffRole: 'super_admin',
    entraObjectId: null,
    isProtected: true,
  });
}

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(status);
    return error as HttpError;
  }
  throw new Error(`expected an HttpError with status ${status}`);
}

describe('UserService (Entra)', () => {
  it('invite: creates the Graph account, invitation row, membership, and email', async () => {
    const h = makeHarness();
    const { user, emailSent } = await h.service.invite({
      email: 'Ada@Example.com',
      name: 'Ada Admin',
      role: 'admin',
      actorEmail: 'karanbirsingh667@gmail.com',
    });

    expect(emailSent).toBe(true);
    expect(user.email).toBe('ada@example.com');
    expect(user.status).toBe('invited');
    expect(user.staffRole).toBe('admin');
    expect(user.isProtected).toBe(false);
    expect(user.memberships).toEqual([]);
    // The public shape never carries the Entra id.
    expect('entraObjectId' in user).toBe(false);

    expect(h.entraCalls).toEqual([
      { op: 'create', email: 'ada@example.com', displayName: 'Ada Admin' },
    ]);

    expect(h.invitations).toHaveLength(1);
    const invitation = h.invitations[0]!;
    expect(invitation.email).toBe('ada@example.com');
    expect(invitation.role).toBe('admin');
    expect(invitation.builderId).toBeNull();
    expect(invitation.entraUserId).toBe('entra-ada@example.com');
    expect(invitation.status).toBe('pending');
    expect(invitation.expiresAt.getTime()).toBe(
      new Date('2026-09-27T18:00:00Z').getTime() + 604_800 * 1000,
    );

    expect(h.sentEmails).toHaveLength(1);
    const sent = h.sentEmails[0]!;
    expect(sent.to).toBe('ada@example.com');
    expect(sent.signInUrl).toBe('https://app.example/admin/login');

    expect(
      h.auditLog.some(
        (e) =>
          e.action === 'user.invited' &&
          e.actorEmail === 'karanbirsingh667@gmail.com',
      ),
    ).toBe(true);
  });

  it('invite: builder grant creates the membership, no staff role', async () => {
    const h = makeHarness();
    const { user } = await h.service.invite({
      email: 'bob@example.com',
      name: 'Bob Builder',
      role: 'builder_member',
      builderId: 'builder-1',
    });

    expect(user.staffRole).toBeNull();
    expect(user.memberships).toHaveLength(1);
    expect(user.memberships[0]!.builderId).toBe('builder-1');
    expect(user.memberships[0]!.role).toBe('builder_member');
    expect(h.invitations[0]!.role).toBe('builder_member');
    expect(h.invitations[0]!.builderId).toBe('builder-1');
  });

  it('invite: rejects mismatched role/builder combinations', async () => {
    const h = makeHarness();
    await expectHttpError(
      h.service.invite({
        email: 'a@example.com',
        name: 'A',
        role: 'admin',
        builderId: 'builder-1',
      }),
      400,
    );
    await expectHttpError(
      h.service.invite({
        email: 'b@example.com',
        name: 'B',
        role: 'builder_admin',
      }),
      400,
    );
    await expectHttpError(
      h.service.invite({ email: 'not-an-email', name: 'C', role: 'viewer' }),
      400,
    );
  });

  it('invite: refuses active, disabled, and protected users', async () => {
    const h = makeHarness();
    await h.service.invite({
      email: 'active@example.com',
      name: 'Active',
      role: 'viewer',
    });
    await h.service.completeInvitation('active@example.com', 'entra-x');

    const conflict = await expectHttpError(
      h.service.invite({
        email: 'active@example.com',
        name: 'Active',
        role: 'viewer',
      }),
      409,
    );
    expect(conflict.message).toContain('already has access');

    await h.service.invite({
      email: 'gone@example.com',
      name: 'Gone',
      role: 'viewer',
    });
    const gone = (await h.service.findByEmail('gone@example.com'))!;
    await h.service.disableUser(gone.id);
    await expectHttpError(
      h.service.invite({
        email: 'gone@example.com',
        name: 'Gone',
        role: 'viewer',
      }),
      409,
    );

    await seedProtected(h);
    const forbidden = await expectHttpError(
      h.service.invite({
        email: 'karanbirsingh667@gmail.com',
        name: 'Karan',
        role: 'admin',
      }),
      403,
    );
    expect(forbidden.code).toBe('PROTECTED_ACCOUNT');
  });

  it('invite: Graph failure leaves the user row but no invitation (resend retries)', async () => {
    const h = makeHarness();
    h.failGraphCreate = true;

    await expectHttpError(
      h.service.invite({
        email: 'flaky@example.com',
        name: 'Flaky',
        role: 'viewer',
      }),
      502,
    );
    expect(h.invitations).toHaveLength(0);
    expect(h.sentEmails).toHaveLength(0);

    // The user row survived — inviting again retries Graph and completes
    // the flow (invite is idempotent for invited users).
    h.failGraphCreate = false;
    const { emailSent } = await h.service.invite({
      email: 'flaky@example.com',
      name: 'Flaky',
      role: 'viewer',
    });
    expect(emailSent).toBe(true);
    expect(h.entraCalls.filter((c) => c.op === 'create')).toEqual([
      { op: 'create', email: 'flaky@example.com', displayName: 'Flaky' },
    ]);
    expect(h.invitations).toHaveLength(1);
    expect(h.invitations[0]!.entraUserId).toBe('entra-flaky@example.com');
  });

  it('resendInvite: revokes the old pending invitation and reuses the Entra id', async () => {
    const h = makeHarness();
    await h.service.invite({
      email: 're@example.com',
      name: 'Re',
      role: 'admin',
    });
    const createsBefore = h.entraCalls.filter((c) => c.op === 'create').length;

    const { user, emailSent } = await h.service.resendInvite('re@example.com');
    expect(emailSent).toBe(true);
    expect(user.email).toBe('re@example.com');

    // No new Graph account — the existing one is reused.
    expect(h.entraCalls.filter((c) => c.op === 'create')).toHaveLength(
      createsBefore,
    );
    expect(
      h.invitations.filter((i) => i.status === 'pending'),
    ).toHaveLength(1);
    expect(
      h.invitations.filter((i) => i.status === 'revoked'),
    ).toHaveLength(1);
    expect(
      h.invitations.find((i) => i.status === 'pending')!.entraUserId,
    ).toBe('entra-re@example.com');
    expect(
      h.auditLog.some((e) => e.action === 'user.invitation_resent'),
    ).toBe(true);
  });

  it('resendInvite: 404 when there is nothing to resend', async () => {
    const h = makeHarness();
    await expectHttpError(h.service.resendInvite('nobody@example.com'), 404);
  });

  it('revokeInvitation: disables the Entra account before revoking locally', async () => {
    const h = makeHarness();
    await h.service.invite({
      email: 'bye@example.com',
      name: 'Bye',
      role: 'viewer',
    });

    await h.service.revokeInvitation(
      'bye@example.com',
      'karanbirsingh667@gmail.com',
    );

    expect(h.entraCalls.filter((c) => c.op === 'setEnabled')).toEqual([
      { op: 'setEnabled', id: 'entra-bye@example.com', enabled: false },
    ]);
    expect(
      h.invitations.filter((i) => i.status === 'pending'),
    ).toHaveLength(0);
    expect(
      h.invitations.filter((i) => i.status === 'revoked'),
    ).toHaveLength(1);
    expect(
      h.auditLog.some(
        (e) =>
          e.action === 'user.invitation_revoked' &&
          e.actorEmail === 'karanbirsingh667@gmail.com',
      ),
    ).toBe(true);

    await expectHttpError(h.service.revokeInvitation('bye@example.com'), 404);
  });

  it('revokeInvitation: Graph failure leaves the invitation pending', async () => {
    const h = makeHarness();
    await h.service.invite({
      email: 'stuck@example.com',
      name: 'Stuck',
      role: 'viewer',
    });
    h.failGraphToggle = true;

    await expectHttpError(h.service.revokeInvitation('stuck@example.com'), 502);
    expect(
      h.invitations.filter((i) => i.status === 'pending'),
    ).toHaveLength(1);
  });

  it('disable/enable: toggles the Entra account and the status; protected is blocked', async () => {
    const h = makeHarness();
    await h.service.invite({
      email: 'temp@example.com',
      name: 'Temp',
      role: 'admin',
    });
    const user = (await h.service.findByEmail('temp@example.com'))!;
    await h.service.completeInvitation('temp@example.com', 'entra-linked-id');

    const disabled = await h.service.disableUser(
      user.id,
      'karanbirsingh667@gmail.com',
    );
    expect(disabled.status).toBe('disabled');
    expect(h.entraCalls.filter((c) => c.op === 'setEnabled')).toEqual([
      { op: 'setEnabled', id: 'entra-linked-id', enabled: false },
    ]);
    // Idempotent.
    await h.service.disableUser(user.id);
    expect(h.entraCalls.filter((c) => c.op === 'setEnabled')).toHaveLength(1);

    const enabled = await h.service.enableUser(user.id);
    expect(enabled.status).toBe('active');
    expect(h.entraCalls.filter((c) => c.op === 'setEnabled').slice(-1)).toEqual(
      [{ op: 'setEnabled', id: 'entra-linked-id', enabled: true }],
    );

    await seedProtected(h);
    const karan = (await h.service.findByEmail('karanbirsingh667@gmail.com'))!;
    const forbidden = await expectHttpError(h.service.disableUser(karan.id), 403);
    expect(forbidden.code).toBe('PROTECTED_ACCOUNT');
    await expectHttpError(h.service.enableUser(karan.id), 403);
  });

  it('completeInvitation: accepts, links the Entra id, and activates', async () => {
    const h = makeHarness();
    await h.service.invite({
      email: 'new@example.com',
      name: 'New',
      role: 'viewer',
    });

    const completed = await h.service.completeInvitation(
      'new@example.com',
      'entra-live-id',
    );
    expect(completed.status).toBe('active');
    expect(h.invitations[0]!.status).toBe('accepted');
    // The Entra id is linked but never exposed in the public shape.
    expect('entraObjectId' in completed).toBe(false);
    expect(
      h.auditLog.some((e) => e.action === 'user.invitation_accepted'),
    ).toBe(true);

    // Builder memberships survive completion.
    await h.service.invite({
      email: 'multi@example.com',
      name: 'Multi',
      role: 'builder_admin',
      builderId: 'builder-1',
    });
    const multi = (await h.service.findByEmail('multi@example.com'))!;
    expect(multi.memberships).toHaveLength(1);
  });

  it('completeInvitation: expired invitation uses the exact buyer-grade copy', async () => {
    const h = makeHarness();
    await h.service.invite({
      email: 'old@example.com',
      name: 'Old',
      role: 'viewer',
    });
    // Expire the invitation by hand (the harness clock is fixed).
    (h.invitations[0] as { expiresAt: Date }).expiresAt = new Date(
      '2026-09-20T18:00:00Z',
    );

    const error = await expectHttpError(
      h.service.completeInvitation('old@example.com', 'entra-x'),
      401,
    );
    expect(error.code).toBe('INVITATION_EXPIRED');
    expect(error.message).toBe(
      'This invitation link has expired. Ask your admin for a new invite.',
    );
  });

  it('completeInvitation: protected account cannot be completed via the API', async () => {
    const h = makeHarness();
    await seedProtected(h);
    await expectHttpError(
      h.service.completeInvitation('karanbirsingh667@gmail.com', 'entra-karan'),
      403,
    );
  });
});
