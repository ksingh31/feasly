/**
 * Unit tests for the builder-auth service (embed/09).
 *
 * The builder-auth service mirrors the admin-auth pattern (magic link +
 * allowlist + session) with a tenant_key bound to every session.
 *
 * Fakes in-memory: no DB, no network. Tests run under vitest.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createBuilderAuthService,
  type BuilderAllowlistStore,
  type BuilderSessionStore,
} from '../src/services/builder-auth.service';
import type { MagicLinkStore } from '../src/services/magic-link.store';
import type { EmailService } from '../src/services/email/email.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';

function makeDeps(overrides?: {
  readonly allowlisted?: boolean;
  readonly tenantKey?: string | null;
  readonly emailSendFails?: boolean;
  readonly onEmailError?: (error: unknown) => void;
}) {
  const allowlisted = overrides?.allowlisted ?? true;
  const tenantKey = overrides?.tenantKey ?? 'elite-craft';

  const allowlist: BuilderAllowlistStore = {
    isAllowlisted: async () => allowlisted,
    getTenantKey: async () => (allowlisted ? tenantKey : null),
    add: async () => {},
    remove: async () => false,
  };

  const sessions: BuilderSessionStore = {
    insert: vi.fn(async (s) => ({ ...s, createdAt: new Date() })),
    findActiveByHash: vi.fn(async () => null),
    findByHash: vi.fn(async () => null),
    revokeByHash: vi.fn(async () => {}),
    revokeByEmail: vi.fn(async () => 0),
    revokeByUserId: vi.fn(async () => 0),
    updateBuilderId: vi.fn(async () => false),
  };

  const audit: AdminAuditStore = {
    log: vi.fn(async () => {}),
  } as unknown as AdminAuditStore;

  const magicLinks: MagicLinkStore = {
    issue: vi.fn(async () => ({
      token: 'raw-token',
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() + 900_000),
    })),
    findByToken: vi.fn(async () => null),
    findByLeadIds: vi.fn(async () => []),
    revokeByLeadIds: vi.fn(async () => 0),
    consume: vi.fn(async () => true),
    revokeByEmail: vi.fn(async () => 0),
  } as unknown as MagicLinkStore;

  const email: EmailService =
    overrides?.emailSendFails === true
      ? ({
          sendMagicLink: vi.fn(async () => ({
            sent: false as const,
            provider: 'log' as const,
            failureReason: 'ACS provider down',
            emailError: 'delivery-failed' as const,
          })),
        } as unknown as EmailService)
      : ({
          sendMagicLink: vi.fn(async () => ({
            sent: true as const,
            provider: 'log' as const,
            messageId: 'msg-1',
          })),
        } as unknown as EmailService);

  const service = createBuilderAuthService({
    allowlist,
    sessions,
    audit,
    magicLinks,
    email,
    appBaseUrl: 'https://feasly.example.com',
    // auth/04: resolves tenant_key → builder row at session creation.
    builders: { getByTenantKey: async () => null },
    magicLinkTtlSeconds: 900,
    builderSessionTtlSeconds: 604800,
    entraSignIn: {
      configured: true,
      logoutEndpoint:
        'https://feaslyext.ciamlogin.com/tenant-123/oauth2/v2.0/logout',
    },
    onEmailError: overrides?.onEmailError,
  });

  return { service, allowlist, sessions, audit, magicLinks, email };
}

describe('builder-auth service (embed/09)', () => {
  it('requestMagicLink returns sent:true for allowlisted email', async () => {
    const { service } = makeDeps();
    const result = await service.requestMagicLink({ email: 'builder@example.com' });
    expect(result.sent).toBe(true);
  });

  it('requestMagicLink returns sent:true for non-allowlisted email (no oracle)', async () => {
    const { service } = makeDeps({ allowlisted: false });
    const result = await service.requestMagicLink({ email: 'stranger@example.com' });
    expect(result.sent).toBe(true);
  });

  it('requestMagicLink mints a magic link for allowlisted email', async () => {
    const { service, magicLinks } = makeDeps();
    await service.requestMagicLink({ email: 'builder@example.com' });
    expect(magicLinks.issue).toHaveBeenCalled();
  });

  it('requestMagicLink does NOT mint for non-allowlisted email', async () => {
    const { service, magicLinks } = makeDeps({ allowlisted: false });
    await service.requestMagicLink({ email: 'stranger@example.com' });
    expect(magicLinks.issue).not.toHaveBeenCalled();
  });

  it('a failed email send still returns sent:true but reports via onEmailError (P0 visibility guard)', async () => {
    const errors: unknown[] = [];
    const { service } = makeDeps({
      emailSendFails: true,
      onEmailError: (e) => void errors.push(e),
    });
    const result = await service.requestMagicLink({ email: 'builder@example.com' });
    // Fire-and-forget: identical response, no timing oracle — but the
    // failure must reach the sink, never be swallowed.
    expect(result.sent).toBe(true);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(String((errors[0] as Error).message)).toContain('ACS provider down');
  });

  it('verifyMagicLink throws 401 for invalid token', async () => {
    const { service } = makeDeps();
    await expect(service.verifyMagicLink('bad-token')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('verifyMagicLink throws 401 when email not allowlisted at verify time', async () => {
    const { service, magicLinks } = makeDeps({ allowlisted: false });
    vi.mocked(magicLinks.findByToken).mockResolvedValueOnce({
      tokenHash: 'hash',
      email: 'removed@example.com',
      purpose: 'builder',
      expiresAt: new Date(Date.now() + 900_000),
      consumedAt: null,
      createdAt: new Date(),
    } as never);
    // Allowlist check fails → 401 (re-verified at consumption).
    await expect(service.verifyMagicLink('raw-token')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('validateSession returns null for unknown token (no throw)', async () => {
    const { service } = makeDeps();
    const result = await service.validateSession('unknown');
    expect(result).toBeNull();
  });

  it('logout with no token returns loggedOut:true (idempotent)', async () => {
    const { service } = makeDeps();
    const result = await service.logout(null);
    expect(result.loggedOut).toBe(true);
    expect(result.entraLogoutUrl).toBe(
      'https://feaslyext.ciamlogin.com/tenant-123/oauth2/v2.0/logout',
    );
    expect(result.entraIdTokenHint).toBeNull();
  });

  it('logout returns the stored id_token as entraIdTokenHint (builder parity)', async () => {
    const { service, sessions } = makeDeps();
    (sessions.findActiveByHash as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'bs-1',
      idToken: 'builder-id-token',
    });
    const result = await service.logout('builder-session-token');
    expect(result.loggedOut).toBe(true);
    expect(result.entraIdTokenHint).toBe('builder-id-token');
  });

  it('logout with an unknown token still succeeds with a null hint', async () => {
    const { service } = makeDeps();
    const result = await service.logout('no-such-token');
    expect(result.loggedOut).toBe(true);
    expect(result.entraIdTokenHint).toBeNull();
  });
});
