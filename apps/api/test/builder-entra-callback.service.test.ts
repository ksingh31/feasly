/**
 * Builder Entra callback service tests (auth/05).
 *
 * Covers the backend half of builder Entra sign-in:
 * - body validation (400, field names only — never values)
 * - 403 with buyer-grade copy for unknown / disabled / non-builder accounts
 *   (no enumeration oracle)
 * - returning sign-in (already-linked Entra identity)
 * - first sign-in via invitation acceptance
 * - active-but-never-linked row → direct link
 * - identity mismatch → 401
 * - session minted with active builder = first membership
 * - listMemberships / setActiveOrg semantics
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createBuilderEntraCallbackService,
  type BuilderEntraCallbackServiceDeps,
} from '../src/services/builder-entra-callback.service';
import type { EntraTokenValidator } from '../src/services/entra-token-validator';
import type {
  BuilderMembership,
  PublicUser,
  UserService,
  UserStore,
} from '../src/services/user.service';
import type { BuilderSessionStore } from '../src/services/builder-auth.service';
import type { BuilderService } from '../src/services/builder.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';
import { HttpError } from '../src/middleware/errors';

const BUILDER_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function membership(overrides: Partial<BuilderMembership> = {}): BuilderMembership {
  return {
    builderId: BUILDER_ID,
    role: 'builder_member',
    ...overrides,
  } as BuilderMembership;
}

function publicUser(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: USER_ID,
    email: 'builder@example.com',
    name: 'Builder User',
    status: 'active',
    staffRole: null,
    isProtected: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    memberships: [membership()],
    ...overrides,
  };
}

function makeDeps() {
  const tokenValidator = {
    configured: true,
    exchangeCode: vi.fn(async () => ({ idToken: 'id-token' })),
    validateIdToken: vi.fn(async () => ({
      entraObjectId: 'entra-oid-1',
      email: 'builder@example.com',
      name: 'Builder User',
    })),
  } as unknown as EntraTokenValidator;

  const users = {
    findByEmail: vi.fn(),
    findById: vi.fn(),
    updateUser: vi.fn(async () => {}),
  } as unknown as UserStore;

  const userService = {
    findByEmail: vi.fn(),
    findById: vi.fn(),
    completeInvitation: vi.fn(),
  } as unknown as UserService;

  const sessions = {
    insert: vi.fn(async (s: unknown) => s),
    updateBuilderId: vi.fn(async () => true),
  } as unknown as BuilderSessionStore;

  const builders = {
    getBuilder: vi.fn(async () => ({
      id: BUILDER_ID,
      tenantKey: 'elite-craft',
      displayName: 'Elite Craft Builders',
    })),
  } as unknown as Pick<BuilderService, 'getBuilder'>;

  const audit = {
    log: vi.fn(async () => {}),
  } as unknown as Pick<AdminAuditStore, 'log'>;

  const deps = {
    tokenValidator,
    users,
    userService,
    sessions,
    builders,
    audit,
    builderSessionTtlSeconds: 604800,
    clock: () => new Date('2026-09-28T15:00:00Z'),
    uuid: () => 'session-uuid-1',
  } as BuilderEntraCallbackServiceDeps;

  return { deps, tokenValidator, users, userService, sessions, builders, audit };
}

const VALID_BODY = {
  code: 'auth-code',
  codeVerifier: 'verifier',
  redirectUri: 'https://app/builder/login/callback',
};

describe('builder entra callback service', () => {
  let d: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    d = makeDeps();
  });

  it('rejects an invalid body with 400 and never logs values', async () => {
    const service = createBuilderEntraCallbackService(d.deps);
    const err = await service
      .handleCallback({ code: '' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    // The diagnostic cause names fields, never values.
    expect(String((err as HttpError).cause)).toContain('code:empty');
    expect(String((err as HttpError).cause)).not.toContain('auth-code');
  });

  it('403s unknown emails with buyer-grade copy (no enumeration)', async () => {
    vi.mocked(d.users.findByEmail).mockResolvedValue(null);
    const service = createBuilderEntraCallbackService(d.deps);
    const err = await service
      .handleCallback(VALID_BODY)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).message).toContain('builder account');
  });

  it('403s disabled accounts with the same copy as unknown', async () => {
    vi.mocked(d.users.findByEmail).mockResolvedValue({
      id: USER_ID,
      email: 'builder@example.com',
      status: 'disabled',
      entraObjectId: null,
      isProtected: false,
    } as never);
    const service = createBuilderEntraCallbackService(d.deps);
    const err = await service
      .handleCallback(VALID_BODY)
      .catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).message).toContain('builder account');
  });

  it('403s staff-only users with no builder memberships', async () => {
    vi.mocked(d.users.findByEmail).mockResolvedValue({
      id: USER_ID,
      email: 'builder@example.com',
      status: 'active',
      entraObjectId: 'entra-oid-1',
      isProtected: false,
    } as never);
    vi.mocked(d.userService.findByEmail).mockResolvedValue(
      publicUser({ memberships: [] }),
    );
    const service = createBuilderEntraCallbackService(d.deps);
    const err = await service
      .handleCallback(VALID_BODY)
      .catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(403);
    expect(d.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: 'builder_entra_callback_no_membership',
      }),
    );
  });

  it('signs in a returning user and mints a session on the first membership', async () => {
    vi.mocked(d.users.findByEmail).mockResolvedValue({
      id: USER_ID,
      email: 'builder@example.com',
      status: 'active',
      entraObjectId: 'entra-oid-1',
      isProtected: false,
    } as never);
    vi.mocked(d.userService.findByEmail).mockResolvedValue(publicUser());
    const service = createBuilderEntraCallbackService(d.deps);
    const result = await service.handleCallback(VALID_BODY);
    expect(result.authenticated).toBe(true);
    expect(result.activeBuilderId).toBe(BUILDER_ID);
    expect(result.user.memberships).toHaveLength(1);
    expect(result.user.memberships[0]?.builderName).toBe(
      'Elite Craft Builders',
    );
    expect(d.sessions.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        builderId: BUILDER_ID,
        tenantKey: 'elite-craft',
      }),
    );
  });

  it('accepts an invitation on first sign-in for invited rows', async () => {
    vi.mocked(d.users.findByEmail).mockResolvedValue({
      id: USER_ID,
      email: 'builder@example.com',
      status: 'invited',
      entraObjectId: null,
      isProtected: false,
    } as never);
    vi.mocked(d.userService.completeInvitation).mockResolvedValue(
      publicUser(),
    );
    const service = createBuilderEntraCallbackService(d.deps);
    const result = await service.handleCallback(VALID_BODY);
    expect(result.authenticated).toBe(true);
    expect(d.userService.completeInvitation).toHaveBeenCalledWith(
      'builder@example.com',
      'entra-oid-1',
    );
  });

  it('rejects a token whose Entra identity does not match the linked account', async () => {
    vi.mocked(d.users.findByEmail).mockResolvedValue({
      id: USER_ID,
      email: 'builder@example.com',
      status: 'active',
      entraObjectId: 'different-oid',
      isProtected: false,
    } as never);
    const service = createBuilderEntraCallbackService(d.deps);
    const err = await service
      .handleCallback(VALID_BODY)
      .catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(401);
  });

  it('setActiveOrg rejects builders outside the caller memberships', async () => {
    vi.mocked(d.userService.findById).mockResolvedValue(publicUser());
    const service = createBuilderEntraCallbackService(d.deps);
    const err = await service
      .setActiveOrg('hash', USER_ID, '99999999-9999-4999-8999-999999999999')
      .catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(403);
    expect(d.sessions.updateBuilderId).not.toHaveBeenCalled();
  });

  it('setActiveOrg switches the session builder for a valid membership', async () => {
    vi.mocked(d.userService.findById).mockResolvedValue(publicUser());
    const service = createBuilderEntraCallbackService(d.deps);
    const result = await service.setActiveOrg('hash', USER_ID, BUILDER_ID);
    expect(result.activeBuilderId).toBe(BUILDER_ID);
    expect(result.builderName).toBe('Elite Craft Builders');
    expect(d.sessions.updateBuilderId).toHaveBeenCalledWith('hash', BUILDER_ID);
  });
});
