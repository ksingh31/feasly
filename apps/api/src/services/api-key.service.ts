/**
 * API key issuance + storage (api-mcp/01).
 *
 * Admin-only lifecycle: issue → (rotate | revoke). The plaintext key is
 * returned EXACTLY once at issuance/rotation; only the SHA-256 hash is
 * stored. Every lifecycle event is audit-logged.
 *
 * Key format: `feasly_live_<32 base62>` or `feasly_test_<32 base62>`.
 * Test keys set `sandbox=true` (writes never send email; rows auto-purge
 * after 30 days — the purge job is a documented follow-up, not this story).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ErrorCodes, HttpError } from '../middleware/errors';
import { builderPausedError, builderStatusAllows } from '../lib/builder-status-policy';

/** Scope allowlist (api-mcp/01 AC3). */
export const API_KEY_SCOPES = [
  'property:read',
  'estimate',
  'estimate:read',
  'lead',
  'lead:read',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Default scopes when the admin omits them (api-mcp/01 AC4). */
export const DEFAULT_API_KEY_SCOPES: readonly ApiKeyScope[] = [
  'property:read',
  'estimate',
  'lead',
];

/** Default per-key rate limit, requests/minute (api-mcp/01 AC4). */
export const DEFAULT_API_KEY_RATE_LIMIT = 100;

const LIVE_PREFIX = 'feasly_live_';
const TEST_PREFIX = 'feasly_test_';
const KEY_ENTROPY_CHARS = 32;

const BASE62 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomKeyBody(): string {
  const bytes = randomBytes(KEY_ENTROPY_CHARS);
  let out = '';
  for (const b of bytes) out += BASE62[b % 62];
  return out;
}

/** SHA-256 hex — the only form in which keys are stored or compared. */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly name: string;
  readonly tenantId: string | null;
  /** Masked display form (`feasly_live_…abcd`) — never the full key. */
  readonly keyPrefix: string;
  readonly scopes: readonly string[];
  readonly rateLimitPerMin: number;
  readonly sandbox: boolean;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
}

export interface ApiKeyStore {
  insert(record: {
    readonly id: string;
    readonly name: string;
    readonly tenantId: string | null;
    readonly keyHash: string;
    readonly keyPrefix: string;
    readonly scopes: readonly string[];
    readonly rateLimitPerMin: number;
    readonly sandbox: boolean;
  }): Promise<ApiKeyRecord>;
  findById(id: string): Promise<ApiKeyRecord | null>;
  /** Lookup by hash for Bearer authentication. Null when unknown/revoked. */
  findActiveByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  listActive(): Promise<ApiKeyRecord[]>;
  revoke(id: string, revokedAt: Date): Promise<ApiKeyRecord | null>;
  touchLastUsed(id: string, at: Date): Promise<void>;
  update(
    id: string,
    patch: {
      readonly scopes?: readonly string[];
      readonly rateLimitPerMin?: number;
    },
  ): Promise<ApiKeyRecord | null>;
}

export interface ApiKeyAuditStore {
  log(entry: {
    readonly apiKeyId: string | null;
    readonly action:
      | 'created'
      | 'rotated'
      | 'revoked'
      | 'scope_changed'
      | 'auth_failed';
    readonly detail?: string;
  }): Promise<void>;
}

export interface ApiKeyServiceDeps {
  readonly keys: ApiKeyStore;
  readonly audit: ApiKeyAuditStore;
  readonly clock?: () => Date;
  readonly newId?: () => string;
  /**
   * #765 (AC6): per-instance cache of successful lookups, seconds. Bounded
   * 0–60 by config so a key revoked on any instance is rejected on every
   * instance within one minute. 0 (default) = no cache.
   */
  readonly authCacheTtlSeconds?: number;
  /**
   * #765 (AC8): which keys this deployment accepts. `live` rejects sandbox
   * keys, `sandbox` rejects live keys, `all` (default) accepts both.
   */
  readonly acceptedModes?: 'all' | 'live' | 'sandbox';
  /**
   * #860: lifecycle status of the builder a key is bound to (`tenant_id`),
   * null when the tenant has no builder row. Read on every authenticate
   * (never cached) so suspending a builder refuses its keys at once. A
   * status that refuses `apiKeys` → 403 BUILDER_PAUSED. Absent = no check.
   */
  readonly builderStatus?: (tenantKey: string) => Promise<string | null>;
}

/** Hard ceiling on the auth cache TTL — revocation must propagate in ≤ 60s. */
export const MAX_API_KEY_AUTH_CACHE_TTL_SECONDS = 60;

const issueRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  tenant_id: z.string().trim().min(1).max(120).optional(),
  scopes: z
    .array(z.string())
    .min(1)
    .max(API_KEY_SCOPES.length)
    .optional(),
  rate_limit: z.number().int().min(1).max(10_000).optional(),
  sandbox: z.boolean().optional(),
});

export interface IssuedApiKey {
  /** The key row (masked prefix only). */
  readonly key: ApiKeyRecord;
  /** Plaintext — returned EXACTLY once, never stored. */
  readonly plaintext: string;
}

export interface ApiKeyService {
  issue(request: unknown): Promise<IssuedApiKey>;
  rotate(keyId: string): Promise<IssuedApiKey>;
  revoke(keyId: string): Promise<void>;
  list(): Promise<readonly ApiKeyRecord[]>;
  update(
    keyId: string,
    patch: {
      readonly scopes?: readonly string[];
      readonly rateLimitPerMin?: number;
    },
  ): Promise<ApiKeyRecord>;
  /**
   * Authenticate a Bearer token for the public API middleware. Returns the
   * key record on success; throws 401 INVALID_API_KEY on any failure
   * (unknown, revoked — no distinction, no oracle).
   */
  authenticate(bearerToken: string): Promise<ApiKeyRecord>;
}

function validateScopes(scopes: readonly string[] | undefined): ApiKeyScope[] {
  const list = scopes ?? [...DEFAULT_API_KEY_SCOPES];
  const unknown = list.filter(
    (s): s is string => !(API_KEY_SCOPES as readonly string[]).includes(s),
  );
  if (unknown.length > 0) {
    throw new HttpError(
      422,
      ErrorCodes.VALIDATION_FAILED,
      `Unknown scope(s): ${unknown.join(', ')}. Allowed: ${API_KEY_SCOPES.join(', ')}.`,
      false,
    );
  }
  return list as ApiKeyScope[];
}

export function createApiKeyService(deps: ApiKeyServiceDeps): ApiKeyService {
  const {
    keys,
    audit,
    clock = () => new Date(),
    newId = () => randomUUID(),
    acceptedModes = 'all',
  } = deps;
  const cacheTtlMs =
    Math.min(
      Math.max(deps.authCacheTtlSeconds ?? 0, 0),
      MAX_API_KEY_AUTH_CACHE_TTL_SECONDS,
    ) * 1000;
  const authCache = new Map<
    string,
    { readonly record: ApiKeyRecord; readonly expiresAt: number }
  >();

  function evict(keyId: string): void {
    for (const [hash, entry] of authCache) {
      if (entry.record.id === keyId) authCache.delete(hash);
    }
  }

  async function lookup(hash: string): Promise<ApiKeyRecord | null> {
    if (cacheTtlMs === 0) return keys.findActiveByHash(hash);
    const now = clock().getTime();
    const hit = authCache.get(hash);
    if (hit && hit.expiresAt > now) return hit.record;
    authCache.delete(hash);
    const record = await keys.findActiveByHash(hash);
    if (record) authCache.set(hash, { record, expiresAt: now + cacheTtlMs });
    return record;
  }

  function modeAccepted(record: ApiKeyRecord): boolean {
    if (acceptedModes === 'live') return !record.sandbox;
    if (acceptedModes === 'sandbox') return record.sandbox;
    return true;
  }

  function mint(sandbox: boolean): { plaintext: string; hash: string; prefix: string } {
    const prefix = sandbox ? TEST_PREFIX : LIVE_PREFIX;
    const body = randomKeyBody();
    const plaintext = `${prefix}${body}`;
    return {
      plaintext,
      hash: hashApiKey(plaintext),
      prefix: `${prefix}…${body.slice(-4)}`,
    };
  }

  return {
    async issue(request: unknown): Promise<IssuedApiKey> {
      const parsed = issueRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new HttpError(
          400,
          ErrorCodes.VALIDATION_FAILED,
          'Invalid API key request.',
          false,
        );
      }
      const scopes = validateScopes(parsed.data.scopes);
      const sandbox = parsed.data.sandbox ?? false;
      const { plaintext, hash, prefix } = mint(sandbox);
      const record = await keys.insert({
        id: newId(),
        name: parsed.data.name,
        tenantId: parsed.data.tenant_id ?? null,
        keyHash: hash,
        keyPrefix: prefix,
        scopes,
        rateLimitPerMin: parsed.data.rate_limit ?? DEFAULT_API_KEY_RATE_LIMIT,
        sandbox,
      });
      await audit.log({
        apiKeyId: record.id,
        action: 'created',
        detail: `name=${record.name} scopes=${scopes.join(',')}`,
      });
      return { key: record, plaintext };
    },

    async rotate(keyId: string): Promise<IssuedApiKey> {
      const existing = await keys.findById(keyId);
      if (!existing || existing.revokedAt) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'API key not found.', false);
      }
      const now = clock();
      // Revoke the old key first — AC5: it must 401 within 60 seconds.
      // The hash lookup filters revoked rows, so revocation is immediate.
      await keys.revoke(keyId, now);
      evict(keyId);
      await audit.log({ apiKeyId: keyId, action: 'revoked', detail: 'rotate' });

      const { plaintext, hash, prefix } = mint(existing.sandbox);
      const record = await keys.insert({
        id: newId(),
        name: existing.name,
        tenantId: existing.tenantId,
        keyHash: hash,
        keyPrefix: prefix,
        scopes: existing.scopes,
        rateLimitPerMin: existing.rateLimitPerMin,
        sandbox: existing.sandbox,
      });
      await audit.log({
        apiKeyId: record.id,
        action: 'rotated',
        detail: `from=${keyId}`,
      });
      return { key: record, plaintext };
    },

    async revoke(keyId: string): Promise<void> {
      const existing = await keys.findById(keyId);
      if (!existing || existing.revokedAt) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'API key not found.', false);
      }
      await keys.revoke(keyId, clock());
      evict(keyId);
      await audit.log({ apiKeyId: keyId, action: 'revoked', detail: 'manual' });
    },

    async update(
      keyId: string,
      patch: {
        readonly scopes?: readonly string[];
        readonly rateLimitPerMin?: number;
      },
    ): Promise<ApiKeyRecord> {
      const existing = await keys.findById(keyId);
      if (!existing || existing.revokedAt) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'API key not found.', false);
      }
      // Validate scopes and rate limit using the same rules as issuance.
      const scopes =
        patch.scopes !== undefined ? validateScopes(patch.scopes) : undefined;
      let rateLimitPerMin: number | undefined;
      if (patch.rateLimitPerMin !== undefined) {
        if (
          !Number.isInteger(patch.rateLimitPerMin) ||
          patch.rateLimitPerMin < 1 ||
          patch.rateLimitPerMin > 10_000
        ) {
          throw new HttpError(
            400,
            ErrorCodes.VALIDATION_FAILED,
            'Invalid rate limit.',
            false,
          );
        }
        rateLimitPerMin = patch.rateLimitPerMin;
      }
      const updated = await keys.update(keyId, { scopes, rateLimitPerMin });
      evict(keyId);
      if (!updated) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'API key not found.', false);
      }
      // Takes effect on the next request — the auth middleware reads the
      // row fresh from the DB on every call (no caching).
      await audit.log({
        apiKeyId: keyId,
        action: 'scope_changed',
        detail: `scopes=${scopes?.join(',') ?? 'unchanged'} rateLimit=${rateLimitPerMin ?? 'unchanged'}`,
      });
      return updated;
    },

    async list(): Promise<readonly ApiKeyRecord[]> {
      return keys.listActive();
    },

    async authenticate(bearerToken: string): Promise<ApiKeyRecord> {
      const record = await lookup(hashApiKey(bearerToken));
      if (!record || !modeAccepted(record)) {
        // Uniform 401 for unknown, revoked and wrong-mode keys (no oracle);
        // the audit detail tells operators which one it was.
        await audit.log({
          apiKeyId: record?.id ?? null,
          action: 'auth_failed',
          detail: record ? `mode-mismatch:${acceptedModes}` : 'unknown-or-revoked',
        });
        throw new HttpError(
          401,
          ErrorCodes.INVALID_API_KEY,
          'Invalid API key.',
          false,
        );
      }
      if (record.tenantId !== null && deps.builderStatus) {
        const status = await deps.builderStatus(record.tenantId);
        if (status !== null && !builderStatusAllows(status, 'apiKeys')) {
          await audit.log({
            apiKeyId: record.id,
            action: 'auth_failed',
            detail: `builder-status:${status}`,
          });
          throw builderPausedError(status);
        }
      }
      await keys.touchLastUsed(record.id, clock());
      return record;
    },
  };
}
