/**
 * Entra callback service tests (auth/02).
 *
 * The token validator, Drizzle user store, UserService, session store, and
 * audit are faked at the interface boundary — no Entra, no database.
 * Covers: returning linked user, first-sign-in via completeInvitation
 * (invited → active + entra_object_id linked), protected seed row and
 * active-but-unlinked rows (direct link), unknown account (403, no
 * session, no enumeration), disabled account, identity mismatch (401),
 * expired/no-pending invitation mapping, builder-side role resolution, bad
 * input, and the 7-day session expiry bound to the user id.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import {
  createEntraCallbackService,
  type EntraCallbackServiceDeps,
} from '../src/services/entra-callback.service';
import { hashSessionToken } from '../src/services/admin-auth.service';
import type { EntraTokenValidator } from '../src/services/entra-token-validator';
import type {
  PublicUser,
  UserRecord,
  UserService,
  UserStore,
} from '../src/services/user.service';

const NOW = new Date('2026-09-27T18:00:00Z');
const TTL_SECONDS = 604_800; // 7 days

const TOKEN_IDENTITY = {
  entraObjectId: 'entra-oid-1',
  email: 'admin@example.com',
  name: 'Ada Admin',
};

function record(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    email: 'admin@example.com',
    name: 'Ada Admin',
    status: 'active',
    staffRole: 'admin',
    entraObjectId: 'entra-oid-1',
    isProtected: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function publicUser(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: 'user-1',
    email: 'admin@example.com',
    name: 'Ada Admin',
    status: 'active',
    staffRole: 'admin',
    isProtected: false,
    createdAt: NOW,
    updatedAt: NOW,
    memberships: [],
    ...overrides,
  };
}

interface Fakes {
  tokenValidator: EntraTokenValidator;
  users: Pick<UserStore, 'findByEmail' | 'updateUser'> & {
    updated: { id: string; patch: unknown }[];
  };
  userService: Pick<UserService, 'findByEmail' | 'completeInvitation'>;
  sessions: {
    insert: ReturnType<typeof vi.fn>;
    inserted: {
      id: string;
      email: string;
      sessionTokenHash: string;
      userId: string | null | undefined;
      expiresAt: Date;
    }[];
  };
  audit: { log: ReturnType<typeof vi.fn> };
}

function makeFakes(opts: {
  record?: UserRecord | null;
  publicUser?: PublicUser | null;
  completeInvitation?:
    | { ok: PublicUser }
    | { error: HttpError };
} = {}): Fakes {
  const rec = opts.record === undefined ? record() : opts.record;
  const updated: Fakes['users']['updated'] = [];
  const inserted: Fakes['sessions']['inserted'] = [];
  const users: Fakes['users'] = {
    updated,
    findByEmail: vi.fn(async () => rec),
    updateUser: vi.fn(async (id: string, patch: object) => {
      updated.push({ id, patch });
      return { ...rec!, ...patch };
    }),
  };
  const pub =
    opts.publicUser === undefined
      ? rec
        ? publicUser({
            id: rec.id,
            email: rec.email,
            name: rec.name,
            status: rec.status,
            staffRole: rec.staffRole,
          })
        : null
      : opts.publicUser;
  const userService: Fakes['userService'] = {
    findByEmail: vi.fn(async () => pub),
    completeInvitation: vi.fn(async () => {
      if (opts.completeInvitation && 'error' in opts.completeInvitation) {
        throw opts.completeInvitation.error;
      }
      return (
        (opts.completeInvitation && opts.completeInvitation.ok) ??
        publicUser({ status: 'active' })
      );
    }),
  };
  const sessions: Fakes['sessions'] = {
    inserted,
    insert: vi.fn(async (session) => {
      inserted.push({ ...session });
      return {
        id: session.id,
        email: session.email,
        sessionTokenHash: session.sessionTokenHash,
        revokedAt: null,
        expiresAt: session.expiresAt,
        createdAt: NOW,
      };
    }),
  };
  const tokenValidator: EntraTokenValidator = {
    configured: true,
    exchangeCode: vi.fn(async () => ({ idToken: 'id-token' })),
    validateIdToken: vi.fn(async () => ({ ...TOKEN_IDENTITY })),
  };
  const audit = { log: vi.fn(async () => ({})) };
  return { tokenValidator, users, userService, sessions, audit };
}

function makeService(fakes: Fakes, deps: Partial<EntraCallbackServiceDeps> = {}) {
  return createEntraCallbackService({
    tokenValidator: fakes.tokenValidator,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    users: fakes.users as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    userService: fakes.userService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessions: fakes.sessions as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audit: fakes.audit as any,
    adminSessionTtlSeconds: TTL_SECONDS,
    clock: () => NOW,
    uuid: () => 'session-id-1',
    ...deps,
  });
}

const BODY = {
  code: 'auth-code',
  codeVerifier: 'verifier',
  redirectUri: 'https://app.example/admin/auth/callback',
};

const UNKNOWN_COPY =
  'We couldn\u2019t find your Feasly account — ask your admin for an invite.';

describe('entra callback service', () => {
  it('linked user → mints a 7-day session bound to the user id', async () => {
    const fakes = makeFakes();
    const service = makeService(fakes);
    const result = await service.handleCallback(BODY);

    expect(result.authenticated).toBe(true);
    expect(result.user).toEqual({
      email: 'admin@example.com',
      name: 'Ada Admin',
      staffRole: 'admin',
    });
    expect(typeof result.sessionToken).toBe('string');
    expect(result.sessionToken).toHaveLength(64);

    // Session row: hashed token, bound to the user, 7-day expiry.
    expect(fakes.sessions.inserted).toHaveLength(1);
    const row = fakes.sessions.inserted[0]!;
    expect(row.id).toBe('session-id-1');
    expect(row.email).toBe('admin@example.com');
    expect(row.userId).toBe('user-1');
    expect(row.sessionTokenHash).toBe(hashSessionToken(result.sessionToken));
    expect(row.sessionTokenHash).not.toBe(result.sessionToken);
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + TTL_SECONDS * 1000);

    expect(fakes.users.updateUser).not.toHaveBeenCalled();
    expect(fakes.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session_created' }),
    );
  });

  it('invited user → completeInvitation links entra_object_id, flips to active', async () => {
    const fakes = makeFakes({
      record: record({ status: 'invited', entraObjectId: null }),
    });
    const service = makeService(fakes);
    const result = await service.handleCallback(BODY);

    expect(result.authenticated).toBe(true);
    expect(fakes.userService.completeInvitation).toHaveBeenCalledWith(
      'admin@example.com',
      'entra-oid-1',
    );
    expect(fakes.users.updateUser).not.toHaveBeenCalled();
    expect(fakes.sessions.inserted).toHaveLength(1);
    expect(fakes.sessions.inserted[0]!.userId).toBe('user-1');
    expect(fakes.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'entra_account_linked' }),
    );
  });

  it('invited row with no pending invitation → 403 unknown account', async () => {
    const fakes = makeFakes({
      record: record({ status: 'invited', entraObjectId: null }),
      completeInvitation: {
        error: new HttpError(404, ErrorCodes.NOT_FOUND, 'No pending invitation.', false),
      },
    });
    const service = makeService(fakes);
    const error = await service.handleCallback(BODY).catch((e) => e);

    expect(error.status).toBe(403);
    expect(error.message).toBe(UNKNOWN_COPY);
    expect(fakes.sessions.inserted).toHaveLength(0);
  });

  it('expired invitation → 401 with the invitation copy', async () => {
    const fakes = makeFakes({
      record: record({ status: 'invited', entraObjectId: null }),
      completeInvitation: {
        error: new HttpError(
          401,
          ErrorCodes.INVITATION_EXPIRED,
          'This invitation link has expired. Ask your admin for a new invite.',
          false,
        ),
      },
    });
    const service = makeService(fakes);
    const error = await service.handleCallback(BODY).catch((e) => e);

    expect(error.status).toBe(401);
    expect(error.message).toBe(
      'This invitation link has expired. Ask your admin for a new invite.',
    );
    expect(fakes.sessions.inserted).toHaveLength(0);
  });

  it('protected seed row → links directly (never via completeInvitation)', async () => {
    const fakes = makeFakes({
      record: record({
        status: 'invited',
        entraObjectId: null,
        isProtected: true,
        staffRole: 'super_admin',
      }),
    });
    const service = makeService(fakes);
    const result = await service.handleCallback(BODY);

    expect(result.authenticated).toBe(true);
    expect(fakes.userService.completeInvitation).not.toHaveBeenCalled();
    expect(fakes.users.updated).toEqual([
      {
        id: 'user-1',
        patch: { status: 'active', entraObjectId: 'entra-oid-1' },
      },
    ]);
    expect(result.user.staffRole).toBe('super_admin');
    expect(fakes.sessions.inserted).toHaveLength(1);
  });

  it('active-but-never-linked row → links directly on verified sign-in', async () => {
    const fakes = makeFakes({
      record: record({ status: 'active', entraObjectId: null }),
    });
    const service = makeService(fakes);
    const result = await service.handleCallback(BODY);

    expect(result.authenticated).toBe(true);
    expect(fakes.userService.completeInvitation).not.toHaveBeenCalled();
    expect(fakes.users.updated).toEqual([
      { id: 'user-1', patch: { entraObjectId: 'entra-oid-1' } },
    ]);
    expect(fakes.sessions.inserted).toHaveLength(1);
  });

  it('unknown Entra account → 403 buyer-grade, no session, no enumeration', async () => {
    const fakes = makeFakes({ record: null, publicUser: null });
    const service = makeService(fakes);
    const error = await service.handleCallback(BODY).catch((e) => e);

    expect(error.status).toBe(403);
    expect(error.message).toBe(UNKNOWN_COPY);
    expect(fakes.sessions.inserted).toHaveLength(0);
    expect(fakes.users.updateUser).not.toHaveBeenCalled();
  });

  it('disabled user → the same 403 (no distinguished oracle)', async () => {
    const fakes = makeFakes({
      record: record({ status: 'disabled' }),
    });
    const service = makeService(fakes);
    const error = await service.handleCallback(BODY).catch((e) => e);

    expect(error.status).toBe(403);
    expect(error.message).toBe(UNKNOWN_COPY);
    expect(fakes.sessions.inserted).toHaveLength(0);
  });

  it('identity mismatch (different linked entra_object_id) → 401', async () => {
    const fakes = makeFakes({
      record: record({ entraObjectId: 'entra-oid-OTHER' }),
    });
    const service = makeService(fakes);
    const error = await service.handleCallback(BODY).catch((e) => e);

    expect(error.status).toBe(401);
    expect(error.message).toBe('Sign-in didn\u2019t complete — try again.');
    expect(fakes.sessions.inserted).toHaveLength(0);
    expect(fakes.users.updateUser).not.toHaveBeenCalled();
  });

  it('builder-side user (null staff_role) → highest membership role', async () => {
    for (const [memberships, expected] of [
      [[{ builderId: 'b1', role: 'builder_member', createdAt: NOW }], 'builder_member'],
      [
        [
          { builderId: 'b1', role: 'builder_member', createdAt: NOW },
          { builderId: 'b2', role: 'builder_admin', createdAt: NOW },
        ],
        'builder_admin',
      ],
      [[], 'builder_member'], // no grant yet — least privilege
    ] as const) {
      const fakes = makeFakes({
        publicUser: publicUser({
          staffRole: null,
          memberships: [...memberships],
        }),
      });
      const service = makeService(fakes);
      const result = await service.handleCallback(BODY);
      expect(result.user.staffRole).toBe(expected);
    }
  });

  it('malformed body → 400', async () => {
    const fakes = makeFakes();
    const service = makeService(fakes);
    for (const bad of [{}, { code: 'x' }, { code: '', codeVerifier: 'v', redirectUri: 'u' }]) {
      const error = await service.handleCallback(bad).catch((e) => e);
      expect(error.status).toBe(400);
    }
    expect(fakes.tokenValidator.exchangeCode).not.toHaveBeenCalled();
  });

  it('exchange failure propagates (no session minted)', async () => {
    const fakes = makeFakes();
    fakes.tokenValidator.exchangeCode = vi.fn(async () => {
      throw Object.assign(new Error('denied'), { status: 401 });
    });
    const service = makeService(fakes);
    const error = await service.handleCallback(BODY).catch((e) => e);
    expect(error.status).toBe(401);
    expect(fakes.sessions.inserted).toHaveLength(0);
  });

  it('never stores the raw session token — only its SHA-256', async () => {
    const fakes = makeFakes();
    const service = makeService(fakes);
    const result = await service.handleCallback(BODY);
    const row = fakes.sessions.inserted[0]!;
    expect(row.sessionTokenHash).toBe(
      createHash('sha256').update(result.sessionToken, 'utf8').digest('hex'),
    );
  });
});
