/**
 * API key service tests (api-mcp/01).
 *
 * Acceptance criteria covered:
 *  1. Plaintext returned exactly once; subsequent reads show masked prefix.
 *  2. DB contains only the hash — no plaintext or reversible form.
 *  3. Scopes validated against the allowlist; unknown → 422.
 *  4. rate_limit defaults to 100/min; default scopes applied.
 *  5. Rotate: old key 401s immediately (revocation is synchronous).
 *  6. feasly_test_ keys set sandbox=true.
 */
import { describe, expect, it } from 'vitest';
import {
  createApiKeyService,
  hashApiKey,
  DEFAULT_API_KEY_RATE_LIMIT,
  DEFAULT_API_KEY_SCOPES,
} from '../src/services/api-key.service';
import type {
  ApiKeyAuditStore,
  ApiKeyRecord,
  ApiKeyStore,
} from '../src/services/api-key.service';
import { HttpError } from '../src/middleware/errors';

interface World {
  records: Map<string, ApiKeyRecord & { keyHash: string }>;
  audits: Array<{ apiKeyId: string | null; action: string; detail?: string }>;
}

function makeWorld(): World {
  return { records: new Map(), audits: [] };
}

function makeService(world: World) {
  const keys: ApiKeyStore = {
    insert: async (record) => {
      const full = {
        ...record,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date('2026-09-25T00:00:00Z'),
      };
      world.records.set(record.id, full);
      const { keyHash: _h, ...rest } = full;
      void _h;
      return rest;
    },
    findById: async (id) => {
      const r = world.records.get(id);
      if (!r) return null;
      const { keyHash: _h, ...rest } = r;
      void _h;
      return rest;
    },
    findActiveByHash: async (keyHash) => {
      for (const r of world.records.values()) {
        if (r.keyHash === keyHash && !r.revokedAt) {
          const { keyHash: _h, ...rest } = r;
          void _h;
          return rest;
        }
      }
      return null;
    },
    listActive: async () => {
      const out: ApiKeyRecord[] = [];
      for (const r of world.records.values()) {
        if (!r.revokedAt) {
          const { keyHash: _h, ...rest } = r;
          void _h;
          out.push(rest);
        }
      }
      return out;
    },
    revoke: async (id, revokedAt) => {
      const r = world.records.get(id);
      if (!r) return null;
      const updated = { ...r, revokedAt };
      world.records.set(id, updated);
      const { keyHash: _h, ...rest } = updated;
      void _h;
      return rest;
    },
    touchLastUsed: async () => {},
  };
  const audit: ApiKeyAuditStore = {
    log: async (entry) => {
      world.audits.push({
        apiKeyId: entry.apiKeyId,
        action: entry.action,
        detail: entry.detail,
      });
    },
  };
  return createApiKeyService({ keys, audit });
}

describe('api-key service (api-mcp/01)', () => {
  it('AC1: issuance returns the plaintext exactly once', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const { key, plaintext } = await service.issue({ name: 'Partner A' });

    expect(plaintext).toMatch(/^feasly_live_[0-9A-Za-z]{32}$/);
    expect(key.keyPrefix).toMatch(/^feasly_live_…[0-9A-Za-z]{4}$/);
    // The stored record never exposes the plaintext.
    expect(JSON.stringify(key)).not.toContain(plaintext);
  });

  it('AC2: only the SHA-256 hash is stored — no plaintext in the DB row', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const { plaintext } = await service.issue({ name: 'Partner A' });

    const stored = [...world.records.values()][0]!;
    expect(stored.keyHash).toBe(hashApiKey(plaintext));
    expect(stored.keyHash).toHaveLength(64);
    // No field on the stored row contains or reverses to the plaintext.
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(plaintext);
    expect(serialized).not.toContain(plaintext.slice(-8));
  });

  it('AC3: unknown scopes → 422', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const error = await service
      .issue({ name: 'X', scopes: ['property:read', 'admin:all'] })
      .catch((e) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(422);
    expect(world.records.size).toBe(0);
  });

  it('AC4: defaults — 100 req/min and property:read, estimate, lead', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const { key } = await service.issue({ name: 'Defaults' });

    expect(key.rateLimitPerMin).toBe(DEFAULT_API_KEY_RATE_LIMIT);
    expect(key.rateLimitPerMin).toBe(100);
    expect([...key.scopes]).toEqual([...DEFAULT_API_KEY_SCOPES]);
  });

  it('AC4: explicit scopes and rate limit are honored', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const { key } = await service.issue({
      name: 'Scoped',
      scopes: ['estimate:read'],
      rate_limit: 50,
    });

    expect([...key.scopes]).toEqual(['estimate:read']);
    expect(key.rateLimitPerMin).toBe(50);
  });

  it('AC5: rotate revokes the old key — it 401s immediately', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const first = await service.issue({ name: 'Rot' });
    const second = await service.rotate(first.key.id);

    // New plaintext, different from the old.
    expect(second.plaintext).not.toBe(first.plaintext);
    expect(second.plaintext).toMatch(/^feasly_live_/);

    // Old key 401s.
    const oldAuth = await service.authenticate(first.plaintext).catch((e) => e);
    expect(oldAuth).toBeInstanceOf(HttpError);
    expect(oldAuth.status).toBe(401);
    expect(oldAuth.code).toBe('INVALID_API_KEY');

    // New key authenticates.
    const authed = await service.authenticate(second.plaintext);
    expect(authed.id).toBe(second.key.id);
  });

  it('revoke is immediate — the key 401s on next use', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const { key, plaintext } = await service.issue({ name: 'Bye' });
    await service.revoke(key.id);

    const result = await service.authenticate(plaintext).catch((e) => e);
    expect(result).toBeInstanceOf(HttpError);
    expect(result.status).toBe(401);
  });

  it('AC6: feasly_test_ keys set sandbox=true', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const { key, plaintext } = await service.issue({
      name: 'Sandbox',
      sandbox: true,
    });

    expect(plaintext).toMatch(/^feasly_test_/);
    expect(key.sandbox).toBe(true);
    expect(key.keyPrefix).toMatch(/^feasly_test_…/);
  });

  it('live keys have sandbox=false', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const { key } = await service.issue({ name: 'Prod' });
    expect(key.sandbox).toBe(false);
  });

  it('every lifecycle event is audit-logged', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const { key } = await service.issue({ name: 'Audit' });
    await service.rotate(key.id);
    // rotate revokes the old + creates the new; revoke the new too.
    const keys = await service.list();
    const current = keys.find((k) => k.id !== key.id)!;
    await service.revoke(current.id);

    const actions = world.audits.map((a) => a.action);
    expect(actions).toContain('created');
    expect(actions).toContain('rotated');
    expect(actions.filter((a) => a === 'revoked').length).toBeGreaterThanOrEqual(2);
    // No audit row contains key material.
    for (const a of world.audits) {
      expect(JSON.stringify(a)).not.toMatch(/feasly_(live|test)_/);
    }
  });

  it('unknown key → 401 INVALID_API_KEY (no oracle)', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const error = await service
      .authenticate('feasly_live_nonexistent')
      .catch((e) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(401);
    expect(error.code).toBe('INVALID_API_KEY');
    expect(world.audits.some((a) => a.action === 'auth_failed')).toBe(true);
  });

  it('list shows masked prefixes only — never plaintext', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const { plaintext } = await service.issue({ name: 'Listed' });
    const keys = await service.list();

    expect(keys).toHaveLength(1);
    expect(keys[0]!.keyPrefix).toMatch(/…/);
    expect(JSON.stringify(keys)).not.toContain(plaintext);
  });
});
