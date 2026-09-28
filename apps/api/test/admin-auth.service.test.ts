/**
 * Admin auth service tests (auth/02).
 *
 * Covers the surviving session-lifecycle surface (the legacy magic-link
 * flow was retired 2026-09-28, Karan): logout revokes the session,
 * validateSession resolves active sessions to the admin email,
 * isSessionExpired distinguishes expired from invalid for the login
 * expiry copy, and logout audit logging.
 */
import { describe, expect, it } from 'vitest';
import {
  createAdminAuthService,
  hashSessionToken,
  type AdminSessionRecord,
  type AdminSessionStore,
} from '../src/services/admin-auth.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';

const NOW = new Date('2026-09-24T12:00:00Z');
const ADMIN_EMAIL = 'admin@example.com';
const SESSION_TTL = 604_800;

function makeSessionStore(): AdminSessionStore & {
  sessions: AdminSessionRecord[];
} {
  const sessions: AdminSessionRecord[] = [];
  return {
    sessions,
    insert: async (s) => {
      const record: AdminSessionRecord = {
        id: s.id,
        email: s.email,
        sessionTokenHash: s.sessionTokenHash,
        userId: s.userId ?? null,
        activeBuilderId: s.activeBuilderId ?? null,
        viewAs: null,
        expiresAt: s.expiresAt,
        revokedAt: null,
        createdAt: NOW,
      };
      sessions.push(record);
      return record;
    },
    updateState: async (hash, patch) => {
      const idx = sessions.findIndex((x) => x.sessionTokenHash === hash);
      if (idx < 0) return;
      const r = sessions[idx]!;
      sessions[idx] = {
        ...r,
        activeBuilderId:
          'activeBuilderId' in patch ? (patch.activeBuilderId ?? null) : r.activeBuilderId,
        viewAs: 'viewAs' in patch ? (patch.viewAs ?? null) : r.viewAs,
      };
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

function makeService(overrides?: { clock?: () => Date }) {
  const sessions = makeSessionStore();
  const audit = makeAudit();
  const service = createAdminAuthService({
    sessions,
    audit,
    clock: overrides?.clock ?? (() => NOW),
  });
  return { service, sessions, audit };
}

/** Insert a session directly (sessions are minted by the Entra flow now). */
async function insertSession(
  sessions: AdminSessionStore,
  token: string,
  email: string,
  expiresAt: Date,
): Promise<void> {
  await sessions.insert({
    id: `sess-${token}`,
    email,
    sessionTokenHash: hashSessionToken(token),
    expiresAt,
  });
}

describe('admin auth service (auth/02)', () => {
  describe('logout', () => {
    it('revokes the session and logs it', async () => {
      const { service, sessions, audit } = makeService();
      await insertSession(
        sessions,
        'sess-token',
        ADMIN_EMAIL,
        new Date(NOW.getTime() + SESSION_TTL * 1000),
      );
      // Valid before logout
      expect(await service.validateSession('sess-token')).toBe(ADMIN_EMAIL);
      const result = await service.logout('sess-token');
      expect(result).toEqual({ loggedOut: true });
      // Invalid after logout
      expect(await service.validateSession('sess-token')).toBeNull();
      const revoked = audit.entries.filter(
        (e: unknown) => (e as { action: string }).action === 'session_revoked',
      );
      expect(revoked).toHaveLength(1);
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

    it('unknown token → null', async () => {
      const { service } = makeService();
      expect(await service.validateSession('nope')).toBeNull();
    });

    it('active session → admin email', async () => {
      const { service, sessions } = makeService();
      await insertSession(
        sessions,
        'sess-token',
        ADMIN_EMAIL,
        new Date(NOW.getTime() + SESSION_TTL * 1000),
      );
      expect(await service.validateSession('sess-token')).toBe(ADMIN_EMAIL);
    });

    it('expired session → null', async () => {
      const { service, sessions } = makeService({
        clock: () => new Date(NOW.getTime() + 2000),
      });
      await insertSession(
        sessions,
        'sess-token',
        ADMIN_EMAIL,
        new Date(NOW.getTime() + 1000), // expired 1s after NOW
      );
      expect(await service.validateSession('sess-token')).toBeNull();
    });

    it('revoked session → null', async () => {
      const { service, sessions } = makeService();
      await insertSession(
        sessions,
        'sess-token',
        ADMIN_EMAIL,
        new Date(NOW.getTime() + SESSION_TTL * 1000),
      );
      await service.logout('sess-token');
      expect(await service.validateSession('sess-token')).toBeNull();
    });
  });

  describe('isSessionExpired', () => {
    it('returns false for null/invalid tokens', async () => {
      const { service } = makeService();
      expect(await service.isSessionExpired(null)).toBe(false);
      expect(await service.isSessionExpired('nope')).toBe(false);
    });

    it('returns false for active sessions', async () => {
      const { service, sessions } = makeService();
      await insertSession(
        sessions,
        'sess-token',
        ADMIN_EMAIL,
        new Date(NOW.getTime() + SESSION_TTL * 1000),
      );
      expect(await service.isSessionExpired('sess-token')).toBe(false);
    });

    it('returns true for expired sessions', async () => {
      const { service, sessions } = makeService({
        clock: () => new Date(NOW.getTime() + 2000),
      });
      await insertSession(
        sessions,
        'sess-token',
        ADMIN_EMAIL,
        new Date(NOW.getTime() + 1000), // expired 1s after NOW
      );
      expect(await service.isSessionExpired('sess-token')).toBe(true);
    });

    it('returns false for revoked sessions (invalid, not expired)', async () => {
      const { service, sessions } = makeService();
      await insertSession(
        sessions,
        'sess-token',
        ADMIN_EMAIL,
        new Date(NOW.getTime() + SESSION_TTL * 1000),
      );
      await service.logout('sess-token');
      expect(await service.isSessionExpired('sess-token')).toBe(false);
    });
  });

  describe('hashSessionToken', () => {
    it('is a stable 64-hex SHA-256 (never the raw token)', () => {
      const hash = hashSessionToken('sess-token');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toBe(hashSessionToken('sess-token'));
      expect(hash).not.toContain('sess-token');
    });
  });
});
