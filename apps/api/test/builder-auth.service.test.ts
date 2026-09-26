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

  const email: EmailService = {
    sendMagicLink: vi.fn(async () => ({ messageId: 'msg-1' })),
  } as unknown as EmailService;

  const service = createBuilderAuthService({
    allowlist,
    sessions,
    audit,
    magicLinks,
    email,
    appBaseUrl: 'https://feasly.example.com',
    magicLinkTtlSeconds: 900,
    builderSessionTtlSeconds: 604800,
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
  });
});
