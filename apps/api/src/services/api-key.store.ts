/**
 * Drizzle-backed ApiKeyStore + ApiKeyAuditStore (api-mcp/01).
 *
 * Only services import from this module (layer boundary: routes and
 * middleware never touch the db directly).
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { apiKeyAuditLog, apiKeys } from '../db/schema';
import type {
  ApiKeyAuditStore,
  ApiKeyRecord,
  ApiKeyStore,
} from './api-key.service';

export interface DrizzleApiKeyStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

function toRecord(row: typeof apiKeys.$inferSelect): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    tenantId: row.tenantId,
    keyPrefix: row.keyPrefix,
    scopes: [...row.scopes],
    rateLimitPerMin: row.rateLimitPerMin,
    sandbox: row.sandbox,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

export function createDrizzleApiKeyStore(
  deps: DrizzleApiKeyStoreDeps,
): ApiKeyStore {
  const { db } = deps;
  return {
    async insert(record): Promise<ApiKeyRecord> {
      const rows = await db.insert(apiKeys).values(record).returning();
      const row = rows[0];
      if (!row) throw new Error('api_keys insert returned no row');
      return toRecord(row);
    },

    async findById(id: string): Promise<ApiKeyRecord | null> {
      const rows = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, id))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async findActiveByHash(keyHash: string): Promise<ApiKeyRecord | null> {
      const rows = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async listActive(): Promise<ApiKeyRecord[]> {
      const rows = await db
        .select()
        .from(apiKeys)
        .where(isNull(apiKeys.revokedAt))
        .orderBy(desc(apiKeys.createdAt));
      return rows.map(toRecord);
    },

    async revoke(id: string, revokedAt: Date): Promise<ApiKeyRecord | null> {
      const rows = await db
        .update(apiKeys)
        .set({ revokedAt })
        .where(eq(apiKeys.id, id))
        .returning();
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async update(
      id: string,
      patch: {
        readonly scopes?: readonly string[];
        readonly rateLimitPerMin?: number;
      },
    ): Promise<ApiKeyRecord | null> {
      const set: { scopes?: readonly string[]; rateLimitPerMin?: number } = {};
      if (patch.scopes !== undefined) set.scopes = [...patch.scopes];
      if (patch.rateLimitPerMin !== undefined)
        set.rateLimitPerMin = patch.rateLimitPerMin;
      if (Object.keys(set).length === 0) {
        const rows = await db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.id, id))
          .limit(1);
        const row = rows[0];
        return row ? toRecord(row) : null;
      }
      const rows = await db
        .update(apiKeys)
        .set(set)
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .returning();
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async touchLastUsed(id: string, at: Date): Promise<void> {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: at })
        .where(eq(apiKeys.id, id));
    },
  };
}

export function createDrizzleApiKeyAuditStore(
  deps: DrizzleApiKeyStoreDeps,
): ApiKeyAuditStore {
  const { db } = deps;
  return {
    async log(entry): Promise<void> {
      // The audit table's id has no DB default — generate it here so the
      // store stays the single place that knows the table's requirements.
      const { randomUUID } = await import('node:crypto');
      await db.insert(apiKeyAuditLog).values({
        id: randomUUID(),
        apiKeyId: entry.apiKeyId,
        action: entry.action,
        detail: entry.detail ?? null,
      });
    },
  };
}
