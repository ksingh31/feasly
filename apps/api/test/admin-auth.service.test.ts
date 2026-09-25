/**
 * Admin auth service tests (admin/01).
 *
 * Covers: allowlisted/non-allowlisted request flows (identical responses,
 * no oracle), magic-link verify (valid/expired/used/replay), session
 * creation (7-day expiry), logout, and session validation.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createAdminAuthService,
  type AdminAllowlistStore,
  type AdminSessionRecord,
  type AdminSessionStore,
} from '../src/services/admin-auth.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';
import type { MagicLinkRecord, MagicLinkStore } from '../src/services/magic-link.store';
import type { EmailService } from '../src/services/email/email.service';
import { ErrorCodes } from '../src/middleware/errors';

const NOW = new Date('2026-09-24T12:00:00Z');
const ADMIN_EMAIL = 'admin@example.com';
const OTHER_EMAIL = 'other@example.com';
const APP_BASE_URL = 'https://feasly.example';
const MAGIC_LINK_TTL = 604_800;
const SESSION_TTL = 604_800;

function makeMagicLinkStore(): MagicLinkStore & {
  issued: { token: string; email: string | null }[];
  links: Map<string, MagicLinkRecord>;
} {
  const issued: { token: string; email: string | null }[] = [];
  const links = new Map<string, MagicLinkRecord>();
  let counter = 0;
  return {
    issued,
    links,
    issue: async (args) => {
      const token = `admin-token-${++counter}`;
      const record: MagicLinkRecord = {
        id: `link-${counter}`,
        leadId: args.leadId,
        purpose: args.purpose ?? 'lead',
        email: args.email ?? null,
        tokenHash: `hash-${token}`,
        expiresAt: new Date(NOW.getTime() + args.ttlSeconds * 1000),
        usedAt: null,
        revokedAt: null,
        createdAt: NOW,
      };
      links.set(token, record);
      issued.push({ token, email: args.email ?? null });
      return { id: record.id, token, expiresAt: record.expiresAt };
    },
    findByToken: async (token: string) => links.get(token) ?? null,
    findByLeadIds: async () => [],
    revokeByLeadIds: async () => 0,
    markUsed: async (id: string) => {
      for (const [token, record] of links) {
        if (record.id === id) {
          if (record.usedAt !== null) return false;
          links.set(token, { ...record, usedAt: NOW });
          return true;
        }
      }
      return false;
    },
  };
}

function makeSessionStore(): AdminSessionStore & {
  sessions: AdminSessionRecord[];
} {
  const sessions: AdminSessionRecord[] = [];
  return {
    sessions,
    insert: async (s) => {
      const record: AdminSessionRecord = {
        ...s,
        revokedAt: null,
        createdAt: NOW,
      };
      sessions.push(record);
      return record;
    },
    findActiveByHash: async (hash: string, now: Date) => {
      const s = sessions.find(
        (r) => r.sessionTokenHash === hash && r.revokedAt === null,
      );
      if (!s) return null;
      return s.expiresAt.getTime() > now.getTime() ? s : null;
    },
    findByHash: async (hash: string) => {
      const s = sessions.find(
        (r) => r.sessionTokenHash === hash && r.revokedAt === null,
      );
      return s ?? null;
    },
    revokeByHash: async (hash: string, revokedAt: Date) => {
      const s = sessions.find((r) => r.sessionTokenHash === hash);
      if (s) {
        const idx = sessions.indexOf(s);
        sessions[idx] = { ...s, revokedAt };
      }
    },
    revokeByEmail: async () => 0,
  };
}

function makeAllowlist(allowlisted: readonly string[]): AdminAllowlistStore {
  const set = new Set(allowlisted.map((e) => e.toLowerCase()));
  return {
    isAllowlisted: async (email: string) => set.has(email.toLowerCase()),
    add: async (email: string) => {
      set.add(email.toLowerCase());
    },
    remove: async (email: string) => set.delete(email.toLowerCase()),
  };
}

function makeAudit(): AdminAuditStore & { entries: unknown[] } {
  const entries: unknown[] = [];
  return {
    entries,
    log: async (entry: { readonly actorEmail: string | null; readonly action: string; readonly detail?: string }) => {
      entries.push(entry);
    },
    append: async (args: { readonly action: string; readonly actorEmail: string | null; readonly detail?: string }) => {
      const record = {
        id: 'audit-1',
        action: args.action,
        actorEmail: args.actorEmail,
        detail: args.detail ?? null,
        createdAt: new Date(),
      };
      entries.push(record);
      return record;
    },
    recent: async () => [],
  };
}

function makeEmail(): EmailService & { sends: unknown[] } {
  const sends: unknown[] = [];
  return {
    sends,
    sendMagicLink: async (input: unknown) => {
      sends.push(input);
      return { messageId: 'test-id' };
    },
  } as unknown as EmailService & { sends: unknown[] };
}

function makeService(overrides?: {
  allowlisted?: readonly string[];
  clock?: () => Date;
}) {
  const magicLinks = makeMagicLinkStore();
  const sessions = makeSessionStore();
  const allowlist = makeAllowlist(overrides?.allowlisted ?? [ADMIN_EMAIL]);
  const audit = makeAudit();
  const email = makeEmail();
  const service = createAdminAuthService({
    allowlist,
    sessions,
    audit,
    magicLinks,
    email,
    appBaseUrl: APP_BASE_URL,
    magicLinkTtlSeconds: MAGIC_LINK_TTL,
    adminSessionTtlSeconds: SESSION_TTL,
    clock: overrides?.clock ?? (() => NOW),
  });
  return { service, magicLinks, sessions, allowlist, audit, email };
}

describe('admin auth service (admin/01)', () => {
  describe('requestMagicLink', () => {
    it('allowlisted email → token issued + email sent, returns { sent: true }', async () => {
      const { service, magicLinks, email } = makeService();
      const result = await service.requestMagicLink({ email: ADMIN_EMAIL });
      expect(result).toEqual({ sent: true });
      expect(magicLinks.issued).toHaveLength(1);
      expect(magicLinks.issued[0]?.email).toBe(ADMIN_EMAIL);
      expect(email.sends).toHaveLength(1);
      const sent = email.sends[0] as { to: string; audience: string; magicLinkUrl: string };
      expect(sent.to).toBe(ADMIN_EMAIL);
      expect(sent.audience).toBe('admin');
      expect(sent.magicLinkUrl).toContain('/admin/verify?token=');
    });

    it('non-allowlisted email → identical response, no token, no email', async () => {
      const { service, magicLinks, email } = makeService();
      const result = await service.requestMagicLink({ email: OTHER_EMAIL });
      expect(result).toEqual({ sent: true });
      expect(magicLinks.issued).toHaveLength(0);
      expect(email.sends).toHaveLength(0);
    });

    it('email is normalized (case/whitespace) before allowlist check', async () => {
      const { service, magicLinks } = makeService();
      await service.requestMagicLink({ email: '  ADMIN@EXAMPLE.COM  ' });
      expect(magicLinks.issued).toHaveLength(1);
    });

    it('invalid email → 400', async () => {
      const { service } = makeService();
      await expect(
        service.requestMagicLink({ email: 'not-an-email' }),
      ).rejects.toMatchObject({
        status: 400,
        code: ErrorCodes.VALIDATION_FAILED,
      });
    });
  });

  describe('verifyMagicLink', () => {
    it('valid token → session created (7-day expiry), returns email + token', async () => {
      const store = makeMagicLinkStore();
      const sessions = makeSessionStore();
      const svc = createAdminAuthService({
        allowlist: makeAllowlist([ADMIN_EMAIL]),
        sessions,
        audit: makeAudit(),
        magicLinks: store,
        email: makeEmail(),
        appBaseUrl: APP_BASE_URL,
        magicLinkTtlSeconds: MAGIC_LINK_TTL,
        adminSessionTtlSeconds: SESSION_TTL,
        clock: () => NOW,
      });
      await svc.requestMagicLink({ email: ADMIN_EMAIL });
      const result = await svc.verifyMagicLink('admin-token-1');
      expect(result.authenticated).toBe(true);
      expect(result.email).toBe(ADMIN_EMAIL);
      expect(result.sessionToken).toMatch(/^[0-9a-f]{64}$/);
      expect(sessions.sessions).toHaveLength(1);
    });

    it('unknown token → 401', async () => {
      const { service } = makeService();
      await expect(service.verifyMagicLink('nope')).rejects.toMatchObject({
        status: 401,
        code: ErrorCodes.UNAUTHENTICATED,
      });
    });

    it('expired token → 401', async () => {
      const store = makeMagicLinkStore();
      const svc = createAdminAuthService({
        allowlist: makeAllowlist([ADMIN_EMAIL]),
        sessions: makeSessionStore(),
        audit: makeAudit(),
        magicLinks: store,
        email: makeEmail(),
        appBaseUrl: APP_BASE_URL,
        magicLinkTtlSeconds: 1, // 1 second TTL
        adminSessionTtlSeconds: SESSION_TTL,
        clock: () => NOW,
      });
      await svc.requestMagicLink({ email: ADMIN_EMAIL });
      // Advance clock past expiry
      const expired = createAdminAuthService({
        allowlist: makeAllowlist([ADMIN_EMAIL]),
        sessions: makeSessionStore(),
        audit: makeAudit(),
        magicLinks: store,
        email: makeEmail(),
        appBaseUrl: APP_BASE_URL,
        magicLinkTtlSeconds: 1,
        adminSessionTtlSeconds: SESSION_TTL,
        clock: () => new Date(NOW.getTime() + 2000),
      });
      await expect(expired.verifyMagicLink('admin-token-1')).rejects.toMatchObject({
        status: 401,
      });
    });

    it('replay (already used) → 401', async () => {
      const store = makeMagicLinkStore();
      const sessions = makeSessionStore();
      const svc = createAdminAuthService({
        allowlist: makeAllowlist([ADMIN_EMAIL]),
        sessions,
        audit: makeAudit(),
        magicLinks: store,
        email: makeEmail(),
        appBaseUrl: APP_BASE_URL,
        magicLinkTtlSeconds: MAGIC_LINK_TTL,
        adminSessionTtlSeconds: SESSION_TTL,
        clock: () => NOW,
      });
      await svc.requestMagicLink({ email: ADMIN_EMAIL });
      await svc.verifyMagicLink('admin-token-1');
      await expect(svc.verifyMagicLink('admin-token-1')).rejects.toMatchObject({
        status: 401,
      });
    });

    it('session has 7-day expiry from config', async () => {
      const store = makeMagicLinkStore();
      const sessions = makeSessionStore();
      const svc = createAdminAuthService({
        allowlist: makeAllowlist([ADMIN_EMAIL]),
        sessions,
        audit: makeAudit(),
        magicLinks: store,
        email: makeEmail(),
        appBaseUrl: APP_BASE_URL,
        magicLinkTtlSeconds: MAGIC_LINK_TTL,
        adminSessionTtlSeconds: SESSION_TTL,
        clock: () => NOW,
      });
      await svc.requestMagicLink({ email: ADMIN_EMAIL });
      await svc.verifyMagicLink('admin-token-1');
      expect(sessions.sessions).toHaveLength(1);
      const session = sessions.sessions[0]!;
      expect(session.expiresAt.getTime() - NOW.getTime()).toBe(
        SESSION_TTL * 1000,
      );
      expect(session.email).toBe(ADMIN_EMAIL);
      // Only the SHA-256 hash is stored — 64 hex chars, never the raw token.
      expect(session.sessionTokenHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('logout', () => {
    it('revokes the session', async () => {
      const store = makeMagicLinkStore();
      const sessions = makeSessionStore();
      const svc = createAdminAuthService({
        allowlist: makeAllowlist([ADMIN_EMAIL]),
        sessions,
        audit: makeAudit(),
        magicLinks: store,
        email: makeEmail(),
        appBaseUrl: APP_BASE_URL,
        magicLinkTtlSeconds: MAGIC_LINK_TTL,
        adminSessionTtlSeconds: SESSION_TTL,
        clock: () => NOW,
      });
      await svc.requestMagicLink({ email: ADMIN_EMAIL });
      const { sessionToken } = await svc.verifyMagicLink('admin-token-1');
      // Valid before logout
      expect(await svc.validateSession(sessionToken)).toBe(ADMIN_EMAIL);
      const result = await svc.logout(sessionToken);
      expect(result).toEqual({ loggedOut: true });
      // Invalid after logout
      expect(await svc.validateSession(sessionToken)).toBeNull();
    });

    it('null token → still returns success (idempotent)', async () => {
      const { service } = makeService();
      const result = await service.logout(null);
      expect(result).toEqual({ loggedOut: true });
    });
  });

  describe('validateSession', () => {
    it('null → null', async () => {
      const { service } = makeService();
      expect(await service.validateSession(null)).toBeNull();
    });

    it('expired session → null', async () => {
      const store = makeMagicLinkStore();
      const sessions = makeSessionStore();
      const svc = createAdminAuthService({
        allowlist: makeAllowlist([ADMIN_EMAIL]),
        sessions,
        audit: makeAudit(),
        magicLinks: store,
        email: makeEmail(),
        appBaseUrl: APP_BASE_URL,
        magicLinkTtlSeconds: MAGIC_LINK_TTL,
        adminSessionTtlSeconds: 1, // 1 second
        clock: () => NOW,
      });
      await svc.requestMagicLink({ email: ADMIN_EMAIL });
      const { sessionToken } = await svc.verifyMagicLink('admin-token-1');
      const later = createAdminAuthService({
        allowlist: makeAllowlist([ADMIN_EMAIL]),
        sessions,
        audit: makeAudit(),
        magicLinks: store,
        email: makeEmail(),
        appBaseUrl: APP_BASE_URL,
        magicLinkTtlSeconds: MAGIC_LINK_TTL,
        adminSessionTtlSeconds: 1,
        clock: () => new Date(NOW.getTime() + 2000),
      });
      expect(await later.validateSession(sessionToken)).toBeNull();
    });
  });

  describe('isSessionExpired', () => {
    it('returns false for null/invalid tokens', async () => {
      const { service } = makeService();
      expect(await service.isSessionExpired(null)).toBe(false);
      expect(await service.isSessionExpired('nope')).toBe(false);
    });

    it('returns true for expired sessions, false for active', async () => {
      const store = makeMagicLinkStore();
      const sessions = makeSessionStore();
      const svc = createAdminAuthService({
        allowlist: makeAllowlist([ADMIN_EMAIL]),
        sessions,
        audit: makeAudit(),
        magicLinks: store,
        email: makeEmail(),
        appBaseUrl: APP_BASE_URL,
        magicLinkTtlSeconds: MAGIC_LINK_TTL,
        adminSessionTtlSeconds: SESSION_TTL,
        clock: () => NOW,
      });
      await svc.requestMagicLink({ email: ADMIN_EMAIL });
      const { sessionToken } = await svc.verifyMagicLink('admin-token-1');
      // Active → not expired
      expect(await svc.isSessionExpired(sessionToken)).toBe(false);
      // Expire it by revoking? No — create an expired session directly.
      // Instead, use a short TTL service and advance the clock.
      const shortStore = makeMagicLinkStore();
      const shortSessions = makeSessionStore();
      const short = createAdminAuthService({
        allowlist: makeAllowlist([ADMIN_EMAIL]),
        sessions: shortSessions,
        audit: makeAudit(),
        magicLinks: shortStore,
        email: makeEmail(),
        appBaseUrl: APP_BASE_URL,
        magicLinkTtlSeconds: MAGIC_LINK_TTL,
        adminSessionTtlSeconds: 1,
        clock: () => NOW,
      });
      await short.requestMagicLink({ email: ADMIN_EMAIL });
      const { sessionToken: shortToken } =
        await short.verifyMagicLink('admin-token-1');
      const later = createAdminAuthService({
        allowlist: makeAllowlist([ADMIN_EMAIL]),
        sessions: shortSessions,
        audit: makeAudit(),
        magicLinks: shortStore,
        email: makeEmail(),
        appBaseUrl: APP_BASE_URL,
        magicLinkTtlSeconds: MAGIC_LINK_TTL,
        adminSessionTtlSeconds: 1,
        clock: () => new Date(NOW.getTime() + 2000),
      });
      expect(await later.isSessionExpired(shortToken)).toBe(true);
    });
  });

  describe('audit', () => {
    it('logs magic_link_requested for allowlisted requests only', async () => {
      const { service, audit } = makeService();
      await service.requestMagicLink({ email: ADMIN_EMAIL });
      await service.requestMagicLink({ email: OTHER_EMAIL });
      const requested = audit.entries.filter(
        (e: unknown) => (e as { action: string }).action === 'magic_link_requested',
      );
      expect(requested).toHaveLength(1);
    });
  });
});

void vi;
