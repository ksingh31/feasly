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
  revokedSessionEmails: string[];
  revokedBuilderSessionUserIds: string[];
  logLines: string[];
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
    revokedSessionEmails: [],
    revokedBuilderSessionUserIds: [],
    logLines: [],
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
    async count() {
      return userRows.size;
    },
    async delete(id) {
      return userRows.delete(id);
    },
    async countActiveByStaffRole(role) {
      let n = 0;
      for (const row of userRows.values()) {
        if (row.staffRole === role && row.status === 'active') n++;
      }
      return n;
    },
    async listActiveStaffAdminIds() {
      return [...userRows.values()]
        .filter(
          (row) =>
            (row.staffRole === 'super_admin' || row.staffRole === 'admin') &&
            row.status === 'active',
        )
        .map((row) => row.id)
        .sort();
    },
    async transact(fn) {
      // In-memory fake: no real transaction — run the guard and the
      // mutation against the same maps, like a serialized tx would.
      return fn({ users, memberships });
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
    async listActiveOrgAdminIds(builderId) {
      const ids: string[] = [];
      for (const [userId, list] of membershipRows) {
        const row = userRows.get(userId);
        if (
          row?.status === 'active' &&
          list.some(
            (m) => m.builderId === builderId && m.role === 'builder_admin',
          )
        ) {
          ids.push(userId);
        }
      }
      return ids.sort();
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
    sessions: {
      async revokeByEmail(email: string) {
        h.revokedSessionEmails.push(email);
        return 1;
      },
    },
    builderSessions: {
      async revokeByUserId(userId: string) {
        h.revokedBuilderSessionUserIds.push(userId);
        return 2;
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
    log: (message: string) => h.logLines.push(message),
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
    // Builder invitees land on the builder sign-in, not the admin one.
    expect(h.sentEmails).toHaveLength(1);
    expect(h.sentEmails[0]!.signInUrl).toBe('https://app.example/builder/login');
  });

  it('invite: a repeat invite while one is pending is rejected with 409 (one invite per email)', async () => {
    const h = makeHarness();
    const input = {
      email: 'bob@example.com',
      name: 'Bob Builder',
      role: 'builder_member' as const,
      builderId: 'builder-1',
    };
    await h.service.invite(input);

    const err = await expectHttpError(h.service.invite(input), 409);
    expect(err.message).toBe(
      'An invite is already on its way to this email address.',
    );

    // Nothing stacked: one invitation, one email, one Graph account, one
    // membership — the repeat tap changed nothing.
    expect(
      h.invitations.filter((i) => i.status === 'pending'),
    ).toHaveLength(1);
    expect(h.sentEmails).toHaveLength(1);
    expect(h.entraCalls.filter((c) => c.op === 'create')).toHaveLength(1);
    const user = (await h.service.findByEmail('bob@example.com'))!;
    expect(user.memberships).toHaveLength(1);
    // The slow-step timings were logged for the single real invite.
    expect(
      h.logLines.some((line) => line.startsWith('invite: Entra step took ')),
    ).toBe(true);
    expect(
      h.logLines.some((line) => line.startsWith('invite: email step took ')),
    ).toBe(true);
  });

  it('invite: a live invite to a DIFFERENT org is also rejected (only 1 invite per email)', async () => {
    const h = makeHarness();
    await h.service.invite({
      email: 'bob@example.com',
      name: 'Bob Builder',
      role: 'builder_member',
      builderId: 'builder-1',
    });

    // Same email, different org — Karan's rule is per email, not per
    // email+org, so this must be rejected too.
    const err = await expectHttpError(
      h.service.invite({
        email: 'bob@example.com',
        name: 'Bob Builder',
        role: 'builder_admin',
        builderId: 'builder-2',
      }),
      409,
    );
    expect(err.message).toBe(
      'An invite is already on its way to this email address.',
    );

    // Nothing stacked: still one invitation, one email, one Graph account.
    expect(
      h.invitations.filter((i) => i.status === 'pending'),
    ).toHaveLength(1);
    expect(h.sentEmails).toHaveLength(1);
    expect(h.entraCalls.filter((c) => c.op === 'create')).toHaveLength(1);
    const user = (await h.service.findByEmail('bob@example.com'))!;
    expect(user.memberships).toHaveLength(1);
  });

  it('invite: an expired pending invitation does not block a fresh invite', async () => {
    const h = makeHarness();
    const now = new Date('2026-09-27T18:00:00Z');
    h.invitations.push({
      id: 'old-invite',
      email: 'cara@example.com',
      invitedBy: null,
      role: 'builder_member',
      builderId: 'builder-1',
      entraUserId: 'entra-cara@example.com',
      status: 'pending',
      expiresAt: new Date(now.getTime() - 3_600_000),
      createdAt: new Date(now.getTime() - 8 * 86_400_000),
    });

    const { emailSent } = await h.service.invite({
      email: 'cara@example.com',
      name: 'Cara',
      role: 'builder_member',
      builderId: 'builder-1',
    });
    expect(emailSent).toBe(true);

    // The dead invite was revoked; exactly one live invite remains, and it
    // reused the earlier Graph account instead of creating a duplicate.
    expect(
      h.invitations.filter((i) => i.status === 'revoked'),
    ).toHaveLength(1);
    const pending = h.invitations.filter((i) => i.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.entraUserId).toBe('entra-cara@example.com');
    expect(h.entraCalls.filter((c) => c.op === 'create')).toHaveLength(0);
    expect(h.sentEmails).toHaveLength(1);
  });

  it('invite: the membership add is idempotent when the membership already exists', async () => {
    const h = makeHarness();
    const input = {
      email: 'dan@example.com',
      name: 'Dan',
      role: 'builder_member' as const,
      builderId: 'builder-1',
    };
    await h.service.invite(input);
    // The first invite's email thread is over (withdrawn) but the org
    // membership stands — inviting again must not stack a second row.
    for (const row of h.invitations) {
      (row as { status: string }).status = 'revoked';
    }

    await h.service.invite({ ...input, name: 'Dan Updated' });

    const user = (await h.service.findByEmail('dan@example.com'))!;
    expect(user.name).toBe('Dan Updated');
    expect(user.memberships).toHaveLength(1);
    expect(user.memberships[0]).toMatchObject({
      builderId: 'builder-1',
      role: 'builder_member',
    });
  });

  it('invite: only a super_admin can grant the super_admin role (auth/04)', async () => {
    const h = makeHarness();
    // An admin inviting a super_admin is self-harm/escalation — 403.
    await expectHttpError(
      h.service.invite({
        email: 'mallory@example.com',
        name: 'Mallory',
        role: 'super_admin',
        actorStaffRole: 'admin',
        actorEmail: 'admin@example.com',
      }),
      403,
    );
    // No role on the actor either — 403.
    await expectHttpError(
      h.service.invite({
        email: 'mallory@example.com',
        name: 'Mallory',
        role: 'super_admin',
      }),
      403,
    );
    expect(h.invitations).toHaveLength(0);
  });

  it('invite: a super_admin can grant the super_admin role (auth/04)', async () => {
    const h = makeHarness();
    const { user } = await h.service.invite({
      email: 'super@example.com',
      name: 'Super Admin',
      role: 'super_admin',
      actorStaffRole: 'super_admin',
      actorEmail: 'karanbirsingh667@gmail.com',
    });
    expect(user.staffRole).toBe('super_admin');
    expect(h.invitations[0]!.role).toBe('super_admin');
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
    );    await expectHttpError(
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
    // auth/07: a second admin keeps the last-admin guard from tripping —
    // this test is about the Entra toggle, not the guard.
    await h.service.invite({ email: 'spare@example.com', name: 'Spare', role: 'admin' });
    await h.service.completeInvitation('spare@example.com', 'entra-spare-id');

    const disabled = await h.service.disableUser(user.id, {
      actorEmail: 'karanbirsingh667@gmail.com',
    });
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

describe('UserService (auth/03 — admin user management guards)', () => {
  async function seedActive(
    h: Harness,
    email: string,
    role: 'super_admin' | 'admin' | 'viewer',
  ) {
    // auth/04 AC4: granting super_admin requires a super_admin actor.
    await h.service.invite({
      email,
      name: email,
      role,
      actorStaffRole: 'super_admin',
    });
    await h.service.completeInvitation(email, `entra-${email}`);
    return (await h.service.findByEmail(email))!;
  }

  it('disableUser: cannot deactivate yourself (403, plain-English)', async () => {
    const h = makeHarness();
    const me = await seedActive(h, 'me@example.com', 'admin');
    const error = await expectHttpError(
      h.service.disableUser(me.id, {
        actorId: me.id,
        actorEmail: 'me@example.com',
      }),
      403,
    );
    expect(error.message).toContain('your own account');
    expect((await h.service.findById(me.id))!.status).toBe('active');
  });

  it('disableUser: cannot deactivate the last active super_admin', async () => {
    const h = makeHarness();
    const only = await seedActive(h, 'only@example.com', 'super_admin');
    const error = await expectHttpError(h.service.disableUser(only.id), 403);
    expect(error.message).toContain('last super admin');

    // A second super_admin unblocks the first one's deactivation.
    const second = await seedActive(h, 'second@example.com', 'super_admin');
    const disabled = await h.service.disableUser(only.id, {
      actorId: second.id,
      actorEmail: 'second@example.com',
    });
    expect(disabled.status).toBe('disabled');
  });

  it('disableUser: revokes admin sessions server-side immediately', async () => {
    const h = makeHarness();
    const user = await seedActive(h, 'gone2@example.com', 'admin');
    // auth/07: a second admin keeps the last-admin guard from tripping —
    // this test is about session revocation, not the guard.
    await seedActive(h, 'spare2@example.com', 'admin');
    await h.service.disableUser(user.id, { actorEmail: 'boss@example.com' });
    expect(h.revokedSessionEmails).toEqual(['gone2@example.com']);
    expect(
      h.auditLog.some(
        (e) =>
          e.action === 'user.disabled' && e.actorEmail === 'boss@example.com',
      ),
    ).toBe(true);
  });

  it('disableUser: revokes builder-portal sessions server-side too', async () => {
    const h = makeHarness();
    const user = await seedActive(h, 'gone3@example.com', 'admin');
    // auth/07: a second admin keeps the last-admin guard from tripping —
    // this test is about session revocation, not the guard.
    await seedActive(h, 'spare3@example.com', 'admin');
    await h.service.disableUser(user.id, { actorEmail: 'boss@example.com' });
    // Both session kinds are killed: admin (by email) and builder portal
    // (by user id). Without the builder revoke, a staff-side disable left
    // the user's portal session live until expiry.
    expect(h.revokedSessionEmails).toEqual(['gone3@example.com']);
    expect(h.revokedBuilderSessionUserIds).toEqual([user.id]);
  });

  it('changeStaffRole: self-demotion and last-super_admin demotion are blocked', async () => {
    const h = makeHarness();
    const me = await seedActive(h, 'boss2@example.com', 'super_admin');

    const selfError = await expectHttpError(
      h.service.changeStaffRole(me.id, 'admin', {
        actorId: me.id,
        actorEmail: 'boss2@example.com',
        actorStaffRole: 'super_admin',
      }),
      403,
    );
    expect(selfError.message).toContain('your own account');

    const lastError = await expectHttpError(
      h.service.changeStaffRole(me.id, 'admin', {
        actorId: 'someone-else',
        actorEmail: 'other@example.com',
        actorStaffRole: 'super_admin',
      }),
      403,
    );
    expect(lastError.message).toContain('last super admin');

    // Only a super_admin may grant super_admin.
    const admin = await seedActive(h, 'pleb@example.com', 'admin');
    await expectHttpError(
      h.service.changeStaffRole(admin.id, 'super_admin', {
        actorId: me.id,
        actorEmail: 'boss2@example.com',
        actorStaffRole: 'admin',
      }),
      403,
    );

    // A legit promotion works and is audit-logged.
    const promoted = await h.service.changeStaffRole(admin.id, 'super_admin', {
      actorId: me.id,
      actorEmail: 'boss2@example.com',
      actorStaffRole: 'super_admin',
    });
    expect(promoted.staffRole).toBe('super_admin');
    expect(
      h.auditLog.some(
        (e) =>
          e.action === 'user.role_changed' &&
          e.detail === 'email=pleb@example.com from=admin to=super_admin',
      ),
    ).toBe(true);
  });

  it('changeStaffRole: protected rows refuse', async () => {
    const h = makeHarness();
    await seedProtected(h);
    const karan = (await h.service.findByEmail('karanbirsingh667@gmail.com'))!;
    const error = await expectHttpError(
      h.service.changeStaffRole(karan.id, 'viewer', {
        actorStaffRole: 'super_admin',
      }),
      403,
    );
    expect(error.code).toBe('PROTECTED_ACCOUNT');
  });

  it('renameUser: renames and audit-logs; protected rows refuse', async () => {
    const h = makeHarness();
    const user = await seedActive(h, 'rename@example.com', 'viewer');
    const renamed = await h.service.renameUser(user.id, 'New Name', {
      actorEmail: 'boss@example.com',
    });
    expect(renamed.name).toBe('New Name');
    expect(
      h.auditLog.some(
        (e) =>
          e.action === 'user.renamed' && e.actorEmail === 'boss@example.com',
      ),
    ).toBe(true);

    await seedProtected(h);
    const karan = (await h.service.findByEmail('karanbirsingh667@gmail.com'))!;
    await expectHttpError(h.service.renameUser(karan.id, 'Hacker'), 403);
  });

  it('setMemberships: replaces the membership set; self + protected blocked', async () => {
    const h = makeHarness();
    const user = await seedActive(h, 'member@example.com', 'viewer');
    const updated = await h.service.setMemberships(
      user.id,
      [
        { builderId: 'builder-a', role: 'builder_admin' },
        { builderId: 'builder-b', role: 'builder_member' },
      ],
      { actorEmail: 'boss@example.com' },
    );
    expect(updated.memberships).toHaveLength(2);

    // auth/07: a second admin for builder-a, so the demote below doesn't
    // trip the last-admin guard — this test is about replace semantics.
    const peer = await seedActive(h, 'peer@example.com', 'viewer');
    await h.service.setMemberships(
      peer.id,
      [{ builderId: 'builder-a', role: 'builder_admin' }],
      { actorEmail: 'boss@example.com' },
    );

    // Role change on an existing membership: remove + re-add.
    const changed = await h.service.setMemberships(
      user.id,
      [{ builderId: 'builder-a', role: 'builder_member' }],
      { actorEmail: 'boss@example.com' },
    );
    expect(changed.memberships).toEqual([
      expect.objectContaining({ builderId: 'builder-a', role: 'builder_member' }),
    ]);

    await expectHttpError(
      h.service.setMemberships(user.id, [], { actorId: user.id }),
      403,
    );
    await seedProtected(h);
    const karan = (await h.service.findByEmail('karanbirsingh667@gmail.com'))!;
    await expectHttpError(h.service.setMemberships(karan.id, []), 403);
  });

  it('deleteUser: hard-deletes a never-accepted user (Graph account first)', async () => {
    const h = makeHarness();
    await h.service.invite({
      email: 'never@example.com',
      name: 'Never',
      role: 'viewer',
    });
    const user = (await h.service.findByEmail('never@example.com'))!;

    await h.service.deleteUser(user.id, { actorEmail: 'boss@example.com' });
    expect(await h.service.findById(user.id)).toBeNull();
    expect(
      h.entraCalls.some(
        (c) => c.op === 'delete' && c.id === 'entra-never@example.com',
      ),
    ).toBe(true);
    expect(
      h.auditLog.some(
        (e) =>
          e.action === 'user.deleted' && e.actorEmail === 'boss@example.com',
      ),
    ).toBe(true);
  });

  it('deleteUser: refuses active users, self, protected, and missing rows', async () => {
    const h = makeHarness();
    const active = await seedActive(h, 'lived@example.com', 'admin');

    const activeError = await expectHttpError(
      h.service.deleteUser(active.id, { actorEmail: 'boss@example.com' }),
      400,
    );
    expect(activeError.message).toContain('deactivate them instead');
    expect(await h.service.findById(active.id)).not.toBeNull();

    const selfError = await expectHttpError(
      h.service.deleteUser(active.id, {
        actorId: active.id,
        actorEmail: 'lived@example.com',
      }),
      403,
    );
    expect(selfError.message).toContain('your own account');

    await seedProtected(h);
    const karan = (await h.service.findByEmail('karanbirsingh667@gmail.com'))!;
    await expectHttpError(h.service.deleteUser(karan.id), 403);

    await expectHttpError(h.service.deleteUser('no-such-id'), 404);
  });

  it('deleteUser: deleting a never-accepted super_admin invite does not trip the last-super_admin guard', async () => {
    const h = makeHarness();
    const only = await seedActive(h, 'solitary@example.com', 'super_admin');
    await h.service.invite({
      email: 'pending-sa@example.com',
      name: 'Pending',
      role: 'super_admin',
      actorStaffRole: 'super_admin',
    });
    const pending = (await h.service.findByEmail('pending-sa@example.com'))!;
    // Never accepted → status invited → hard delete is fine even though
    // there is only one ACTIVE super_admin.
    await h.service.deleteUser(pending.id, { actorId: only.id });
    expect(await h.service.findById(pending.id)).toBeNull();
  });

  it('listUsers/countUsers: paginated list with totals', async () => {
    const h = makeHarness();
    await h.service.invite({ email: 'a@example.com', name: 'A', role: 'viewer' });
    await h.service.invite({ email: 'b@example.com', name: 'B', role: 'admin' });
    expect(await h.service.countUsers()).toBe(2);
    const page = await h.service.listUsers(1, 0);
    expect(page).toHaveLength(1);
    expect(page[0]!.memberships).toEqual([]);
  });
});

describe('UserService (auth/07 — last-admin protection)', () => {
  async function seedActive(
    h: Harness,
    email: string,
    role: 'super_admin' | 'admin' | 'viewer',
  ) {
    await h.service.invite({
      email,
      name: email,
      role,
      actorStaffRole: 'super_admin',
    });
    await h.service.completeInvitation(email, `entra-${email}`);
    return (await h.service.findByEmail(email))!;
  }

  async function seedOrgAdmin(h: Harness, email: string, builderId: string) {
    const user = await seedActive(h, email, 'viewer');
    await h.service.setMemberships(
      user.id,
      [{ builderId, role: 'builder_admin' }],
      { actorEmail: 'boss@example.com' },
    );
    return user;
  }

  it('changeStaffRole: demoting the last staff admin is refused (409 LAST_ADMIN, exact copy)', async () => {
    const h = makeHarness();
    const only = await seedActive(h, 'only@example.com', 'admin');
    const error = await expectHttpError(
      h.service.changeStaffRole(only.id, 'viewer', {
        actorId: 'someone-else',
        actorEmail: 'other@example.com',
        actorStaffRole: 'super_admin',
      }),
      409,
    );
    expect(error.code).toBe('LAST_ADMIN');
    expect(error.message).toBe(
      "You can't change the role of the last administrator. Add another administrator first.",
    );
    // Nothing changed, and the blocked attempt is audit-logged.
    expect((await h.service.findById(only.id))!.staffRole).toBe('admin');
    expect(
      h.auditLog.some(
        (e) =>
          e.action === 'user.last_admin_blocked' &&
          e.actorEmail === 'other@example.com',
      ),
    ).toBe(true);
  });

  it('changeStaffRole: demoting one of two staff admins succeeds', async () => {
    const h = makeHarness();
    const first = await seedActive(h, 'first@example.com', 'admin');
    await seedActive(h, 'second@example.com', 'admin');
    const demoted = await h.service.changeStaffRole(first.id, 'viewer', {
      actorId: 'someone-else',
      actorEmail: 'other@example.com',
      actorStaffRole: 'super_admin',
    });
    expect(demoted.staffRole).toBe('viewer');
  });

  it('changeStaffRole: pending and deactivated admins never count toward the guard', async () => {
    const h = makeHarness();
    const only = await seedActive(h, 'only@example.com', 'admin');
    const second = await seedActive(h, 'second@example.com', 'admin');
    // Deactivating one of two active admins is allowed...
    await h.service.disableUser(second.id, {
      actorId: only.id,
      actorEmail: 'only@example.com',
    });
    // ...but now the deactivated admin no longer counts: demoting the
    // only ACTIVE admin is refused.
    const error = await expectHttpError(
      h.service.changeStaffRole(only.id, 'viewer', {
        actorStaffRole: 'super_admin',
        actorEmail: 'x@example.com',
      }),
      409,
    );
    expect(error.code).toBe('LAST_ADMIN');
    // A never-accepted invite never counts either.
    await h.service.invite({
      email: 'pending@example.com',
      name: 'Pending',
      role: 'admin',
      actorStaffRole: 'super_admin',
    });
    await expectHttpError(
      h.service.changeStaffRole(only.id, 'viewer', {
        actorStaffRole: 'super_admin',
        actorEmail: 'x@example.com',
      }),
      409,
    );
  });

  it('changeStaffRole: the last admin cannot demote themselves (403 self-harm guard)', async () => {
    const h = makeHarness();
    const me = await seedActive(h, 'me@example.com', 'admin');
    const error = await expectHttpError(
      h.service.changeStaffRole(me.id, 'viewer', {
        actorId: me.id,
        actorEmail: 'me@example.com',
        actorStaffRole: 'super_admin',
      }),
      403,
    );
    expect(error.message).toContain('your own account');
    expect((await h.service.findById(me.id))!.staffRole).toBe('admin');
  });

  it('disableUser: deactivating the last staff admin is refused (409, exact copy)', async () => {
    const h = makeHarness();
    const only = await seedActive(h, 'only@example.com', 'admin');
    const error = await expectHttpError(
      h.service.disableUser(only.id, {
        actorId: 'someone-else',
        actorEmail: 'other@example.com',
      }),
      409,
    );
    expect(error.code).toBe('LAST_ADMIN');
    expect(error.message).toBe(
      'Every organization needs at least one active administrator.',
    );
    expect((await h.service.findById(only.id))!.status).toBe('active');
    expect(
      h.auditLog.some(
        (e) =>
          e.action === 'user.last_admin_blocked' &&
          e.actorEmail === 'other@example.com',
      ),
    ).toBe(true);
  });

  it('disableUser: deactivating one of two staff admins succeeds', async () => {
    const h = makeHarness();
    const first = await seedActive(h, 'first@example.com', 'admin');
    await seedActive(h, 'second@example.com', 'admin');
    const disabled = await h.service.disableUser(first.id, {
      actorEmail: 'boss@example.com',
    });
    expect(disabled.status).toBe('disabled');
  });

  it('disableUser: deactivating the sole builder_admin of an org is refused', async () => {
    const h = makeHarness();
    const sole = await seedOrgAdmin(h, 'sole@example.com', 'builder-a');
    const error = await expectHttpError(
      h.service.disableUser(sole.id, { actorEmail: 'boss@example.com' }),
      409,
    );
    expect(error.code).toBe('LAST_ADMIN');
    expect(error.message).toBe(
      'Every organization needs at least one active administrator.',
    );
    expect((await h.service.findById(sole.id))!.status).toBe('active');
  });

  it('disableUser: per-org check — sole admin of one org is blocked even with a co-admin in another', async () => {
    const h = makeHarness();
    const u1 = await seedActive(h, 'u1@example.com', 'viewer');
    const u2 = await seedActive(h, 'u2@example.com', 'viewer');
    await h.service.setMemberships(
      u1.id,
      [
        { builderId: 'org-a', role: 'builder_admin' },
        { builderId: 'org-b', role: 'builder_admin' },
      ],
      { actorEmail: 'boss@example.com' },
    );
    await h.service.setMemberships(
      u2.id,
      [{ builderId: 'org-b', role: 'builder_admin' }],
      { actorEmail: 'boss@example.com' },
    );
    // u1 is the sole admin of org-a → deactivation refused even though
    // org-b still has u2.
    await expectHttpError(
      h.service.disableUser(u1.id, { actorEmail: 'boss@example.com' }),
      409,
    );
    // u2 (co-admin of org-b only) can be deactivated.
    const disabled = await h.service.disableUser(u2.id, {
      actorEmail: 'boss@example.com',
    });
    expect(disabled.status).toBe('disabled');
  });

  it('setMemberships: demoting or removing the sole builder_admin of an org is refused', async () => {
    const h = makeHarness();
    const sole = await seedOrgAdmin(h, 'sole@example.com', 'builder-a');
    const demote = (desired: { builderId: string; role: 'builder_admin' | 'builder_member' }[]) =>
      h.service.setMemberships(sole.id, desired, {
        actorEmail: 'boss@example.com',
      });
    // Demote to member…
    const error = await expectHttpError(
      demote([{ builderId: 'builder-a', role: 'builder_member' }]),
      409,
    );
    expect(error.code).toBe('LAST_ADMIN');
    expect(error.message).toBe(
      "You can't change the role of the last administrator. Add another administrator first.",
    );
    // …or remove the membership entirely (what the builder "remove team
    // member" flow does) — also refused.
    await expectHttpError(demote([]), 409);
    // With a second admin in place, the demotion succeeds.
    await seedOrgAdmin(h, 'second@example.com', 'builder-a');
    const changed = await demote([
      { builderId: 'builder-a', role: 'builder_member' },
    ]);
    expect(changed.memberships).toEqual([
      expect.objectContaining({
        builderId: 'builder-a',
        role: 'builder_member',
      }),
    ]);
  });

  it('deleteUser: deleting a never-accepted builder_admin invite never trips the guard', async () => {
    const h = makeHarness();
    const sole = await seedOrgAdmin(h, 'sole@example.com', 'builder-a');
    await h.service.invite({
      email: 'pending@example.com',
      name: 'Pending',
      role: 'viewer',
      actorStaffRole: 'super_admin',
    });
    const pending = (await h.service.findByEmail('pending@example.com'))!;
    await h.service.setMemberships(
      pending.id,
      [{ builderId: 'builder-a', role: 'builder_admin' }],
      { actorEmail: 'boss@example.com' },
    );
    // The pending invite holds a builder_admin membership but never
    // accepted — deleting it must not trip the last-admin guard.
    await h.service.deleteUser(pending.id, { actorId: sole.id });
    expect(await h.service.findById(pending.id)).toBeNull();
    // And the live sole admin is still protected.
    await expectHttpError(
      h.service.disableUser(sole.id, { actorEmail: 'boss@example.com' }),
      409,
    );
  });

  it('setMemberships: removing a never-accepted invite never trips the guard', async () => {
    const h = makeHarness();
    await seedOrgAdmin(h, 'sole@example.com', 'builder-a');
    await h.service.invite({
      email: 'pending2@example.com',
      name: 'Pending Two',
      role: 'viewer',
      actorStaffRole: 'super_admin',
    });
    const pending = (await h.service.findByEmail('pending2@example.com'))!;
    await h.service.setMemberships(
      pending.id,
      [{ builderId: 'builder-a', role: 'builder_admin' }],
      { actorEmail: 'boss@example.com' },
    );
    // Removing the invite's membership is allowed — the invite never
    // counted as an admin.
    const updated = await h.service.setMemberships(pending.id, [], {
      actorEmail: 'boss@example.com',
    });
    expect(updated.memberships).toEqual([]);
  });
});
