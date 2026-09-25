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
}

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
  } = deps;

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
      await audit.log({ apiKeyId: keyId, action: 'revoked', detail: 'manual' });
    },

    async list(): Promise<readonly ApiKeyRecord[]> {
      return keys.listActive();
    },

    async authenticate(bearerToken: string): Promise<ApiKeyRecord> {
      const record = await keys.findActiveByHash(hashApiKey(bearerToken));
      if (!record) {
        await audit.log({
          apiKeyId: null,
          action: 'auth_failed',
          detail: 'unknown-or-revoked',
        });
        throw new HttpError(
          401,
          ErrorCodes.INVALID_API_KEY,
          'Invalid API key.',
          false,
        );
      }
      await keys.touchLastUsed(record.id, clock());
      return record;
    },
  };
}
