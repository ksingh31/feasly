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
  MAX_API_KEY_AUTH_CACHE_TTL_SECONDS,
} from '../src/services/api-key.service';
import { loadConfig } from '../src/config';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;
import type {
  ApiKeyServiceDeps,
  ApiKeyAuditStore,
  ApiKeyRecord,
  ApiKeyStore,
} from '../src/services/api-key.service';
import { HttpError } from '../src/middleware/errors';

interface World {
  records: Map<string, ApiKeyRecord & { keyHash: string }>;
  audits: Array<{ apiKeyId: string | null; action: string; detail?: string }>;
  /** Number of store hash lookups (proves cache / no-cache behaviour). */
  lookups: number;
}

function makeWorld(): World {
  return { records: new Map(), audits: [], lookups: 0 };
}

function makeService(
  world: World,
  extra: Partial<Omit<ApiKeyServiceDeps, 'keys' | 'audit'>> = {},
) {
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
      world.lookups += 1;
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
    update: async (id, patch) => {
      const r = world.records.get(id);
      if (!r || r.revokedAt) return null;
      const updated = {
        ...r,
        scopes: patch.scopes ? [...patch.scopes] : r.scopes,
        rateLimitPerMin: patch.rateLimitPerMin ?? r.rateLimitPerMin,
      };
      world.records.set(id, updated);
      const { keyHash: _h, ...rest } = updated;
      void _h;
      return rest;
    },
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
  return createApiKeyService({ keys, audit, ...extra });
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

  it('update changes scopes and rate limit — takes effect on next auth', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const { key, plaintext } = await service.issue({
      name: 'Updatable',
      scopes: ['estimate'],
      rate_limit: 60,
    });
    expect(key.scopes).toEqual(['estimate']);

    const updated = await service.update(key.id, {
      scopes: ['estimate', 'property:read'],
      rateLimitPerMin: 120,
    });
    expect(updated.scopes).toEqual(['estimate', 'property:read']);
    expect(updated.rateLimitPerMin).toBe(120);

    // The next authenticate sees the updated record.
    const authed = await service.authenticate(plaintext);
    expect(authed.scopes).toEqual(['estimate', 'property:read']);
    expect(authed.rateLimitPerMin).toBe(120);

    // Audit-logged as scope_changed.
    expect(
      world.audits.some((a) => a.action === 'scope_changed'),
    ).toBe(true);
  });

  it('update rejects invalid scopes and out-of-range rate limits', async () => {
    const world = makeWorld();
    const service = makeService(world);

    const { key } = await service.issue({ name: 'Strict' });

    await expect(
      service.update(key.id, { scopes: ['nope'] }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      service.update(key.id, { rateLimitPerMin: 0 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.update(key.id, { rateLimitPerMin: 10_001 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('update 404s on unknown or revoked keys', async () => {
    const world = makeWorld();
    const service = makeService(world);

    await expect(
      service.update('missing', { rateLimitPerMin: 10 }),
    ).rejects.toMatchObject({ status: 404 });

    const { key } = await service.issue({ name: 'Gone' });
    await service.revoke(key.id);
    await expect(
      service.update(key.id, { rateLimitPerMin: 10 }),
    ).rejects.toMatchObject({ status: 404 });
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

/**
 * #765 (go-live AC6): revoking a key takes effect within one minute across
 * instances. Two service instances share one store (= two Function App
 * instances sharing Postgres); the key is revoked through instance A and
 * must be rejected by instance B.
 */
describe('api-key revocation propagation across instances (#765 AC6)', () => {
  async function authStatus(
    service: ReturnType<typeof makeService>,
    plaintext: string,
  ): Promise<number> {
    try {
      await service.authenticate(plaintext);
      return 200;
    } catch (e) {
      return (e as HttpError).status;
    }
  }

  it('default config has no auth cache — every request re-reads the key row', async () => {
    const world = makeWorld();
    const ttl = loadConfig(BASE_ENV)
      .apiKeyAuth.authCacheTtlSeconds;
    expect(ttl).toBe(0);
    const a = makeService(world, { authCacheTtlSeconds: ttl });
    const b = makeService(world, { authCacheTtlSeconds: ttl });
    const { key, plaintext } = await a.issue({ name: 'Two instances' });

    expect(await authStatus(b, plaintext)).toBe(200);
    expect(await authStatus(b, plaintext)).toBe(200);
    expect(world.lookups).toBe(2);

    await a.revoke(key.id);
    // Instance B rejects on the very next request — no lag at all.
    expect(await authStatus(b, plaintext)).toBe(401);
  });

  it('config rejects an auth cache TTL above 60 seconds', () => {
    const base = BASE_ENV;
    expect(
      loadConfig({ ...base, API_KEY_AUTH_CACHE_TTL_SECONDS: '60' }).apiKeyAuth
        .authCacheTtlSeconds,
    ).toBe(60);
    expect(() =>
      loadConfig({ ...base, API_KEY_AUTH_CACHE_TTL_SECONDS: '61' }),
    ).toThrow();
    expect(MAX_API_KEY_AUTH_CACHE_TTL_SECONDS).toBe(60);
  });

  it('with the maximum cache TTL, another instance rejects a revoked key within 60s', async () => {
    const world = makeWorld();
    let now = new Date('2026-11-16T12:00:00Z').getTime();
    const clock = () => new Date(now);
    const a = makeService(world, { clock, authCacheTtlSeconds: 60 });
    const b = makeService(world, { clock, authCacheTtlSeconds: 60 });
    const { key, plaintext } = await a.issue({ name: 'Cached' });

    // B caches the successful lookup.
    expect(await authStatus(b, plaintext)).toBe(200);
    const lookupsAfterWarm = world.lookups;
    expect(await authStatus(b, plaintext)).toBe(200);
    expect(world.lookups).toBe(lookupsAfterWarm); // served from cache

    await a.revoke(key.id);
    // The revoking instance rejects immediately (its cache is evicted).
    expect(await authStatus(a, plaintext)).toBe(401);

    // B may still accept from cache until the TTL lapses — never longer.
    now += 59_000;
    expect(await authStatus(b, plaintext)).toBe(200);
    now += 1_000; // exactly 60s after B cached the record
    expect(await authStatus(b, plaintext)).toBe(401);
  });

  it('an out-of-range TTL passed directly is clamped to 60s', async () => {
    const world = makeWorld();
    let now = new Date('2026-11-16T12:00:00Z').getTime();
    const clock = () => new Date(now);
    const a = makeService(world, { clock });
    const b = makeService(world, { clock, authCacheTtlSeconds: 3_600 });
    const { key, plaintext } = await a.issue({ name: 'Clamp' });
    expect(await authStatus(b, plaintext)).toBe(200);
    await a.revoke(key.id);
    now += 60_000;
    expect(await authStatus(b, plaintext)).toBe(401);
  });

  it('scope updates evict the cache on the updating instance', async () => {
    const world = makeWorld();
    const service = makeService(world, { authCacheTtlSeconds: 60 });
    const { key, plaintext } = await service.issue({ name: 'Scopes' });
    await service.authenticate(plaintext);
    await service.update(key.id, { scopes: ['property:read'] });
    const record = await service.authenticate(plaintext);
    expect(record.scopes).toEqual(['property:read']);
  });
});

/**
 * #765 (go-live AC8): a sandbox key is rejected by a production (live-only)
 * deployment and a live key is rejected by a sandbox-only deployment.
 */
describe('api-key live/sandbox isolation (#765 AC8)', () => {
  async function issueBoth(world: World) {
    const issuer = makeService(world);
    const live = await issuer.issue({ name: 'Live' });
    const sandbox = await issuer.issue({ name: 'Sandbox', sandbox: true });
    return { live, sandbox };
  }

  it('production (live-only) rejects a sandbox key with a uniform 401', async () => {
    const world = makeWorld();
    const { live, sandbox } = await issueBoth(world);
    const prod = makeService(world, { acceptedModes: 'live' });

    expect((await prod.authenticate(live.plaintext)).id).toBe(live.key.id);
    const err = await prod.authenticate(sandbox.plaintext).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('INVALID_API_KEY');
    expect(err.message).toBe('Invalid API key.');
    expect(world.audits.at(-1)).toEqual({
      apiKeyId: sandbox.key.id,
      action: 'auth_failed',
      detail: 'mode-mismatch:live',
    });
  });

  it('sandbox-only deployment rejects a live key with a uniform 401', async () => {
    const world = makeWorld();
    const { live, sandbox } = await issueBoth(world);
    const sbx = makeService(world, { acceptedModes: 'sandbox' });

    expect((await sbx.authenticate(sandbox.plaintext)).id).toBe(sandbox.key.id);
    const err = await sbx.authenticate(live.plaintext).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('INVALID_API_KEY');
  });

  it('mode isolation also holds when the record is served from the auth cache', async () => {
    const world = makeWorld();
    const { sandbox } = await issueBoth(world);
    const prod = makeService(world, {
      acceptedModes: 'live',
      authCacheTtlSeconds: 60,
    });
    for (let i = 0; i < 2; i += 1) {
      const err = await prod.authenticate(sandbox.plaintext).catch((e) => e);
      expect(err.status).toBe(401);
    }
  });

  it("default ('all') keeps today's behaviour — both keys authenticate", async () => {
    const world = makeWorld();
    const { live, sandbox } = await issueBoth(world);
    const mode = loadConfig(BASE_ENV)
      .apiKeyAuth.acceptedModes;
    expect(mode).toBe('all');
    const svc = makeService(world, { acceptedModes: mode });
    expect((await svc.authenticate(live.plaintext)).sandbox).toBe(false);
    expect((await svc.authenticate(sandbox.plaintext)).sandbox).toBe(true);
  });

  it('config accepts only all | live | sandbox', () => {
    const base = BASE_ENV;
    expect(
      loadConfig({ ...base, API_KEY_ACCEPTED_MODES: 'live' }).apiKeyAuth.acceptedModes,
    ).toBe('live');
    expect(() => loadConfig({ ...base, API_KEY_ACCEPTED_MODES: 'prod' })).toThrow();
  });
});
