/**
 * Builder-config service tests (EMB-02).
 *
 * Covers: repo-JSON (in-memory) hit, DB `tenants` fallback when the key
 * is not in memory, 404 UNKNOWN_TENANT when neither has it, and startup
 * validation failing loud on a broken injected config.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  createBuilderConfigService,
  type BuilderConfigService,
} from '../src/services/builder-config.service';
import { tenants } from '../src/db/schema';
import type { AppDb } from '../src/db/client';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import { createTestDb, type TestDb } from './pglite-db';

const FILE_CONFIG = {
  tenant_key: 'elite-craft-builders',
  business_name: 'Elite Craft Builders',
  display_name: 'Elite Craft Builders',
  logo_url: '',
  accent_color: '#1a365d',
  allowed_origins: ['https://elitecraftbuilders.com'],
  fallback_phone: '',
  fallback_email: '',
  plan: null,
};

const NO_DB = {} as AppDb;
const QUIET = { onWarning: () => {} };

function serviceWith(
  configs: Record<string, unknown>,
  db: AppDb = NO_DB,
): BuilderConfigService {
  return createBuilderConfigService({
    db,
    configs,
    isDev: false,
    ...QUIET,
  });
}

describe('builder-config service', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    // PGlite WASM init + migrations can exceed vitest's 10s default hook
    // timeout on cold/loaded machines.
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('serves the in-memory repo JSON without touching the DB', async () => {
    const service = serviceWith({ 'elite-craft-builders': FILE_CONFIG });
    const config = await service.getByKey('elite-craft-builders');
    expect(config).toEqual({
      business_name: 'Elite Craft Builders',
      display_name: 'Elite Craft Builders',
      logo_url: '',
      accent_color: '#1a365d',
      allowed_origins: ['https://elitecraftbuilders.com'],
      fallback_phone: '',
      fallback_email: '',
      plan: null,
    });
    // tenant_key is internal — never on the wire.
    expect(config).not.toHaveProperty('tenant_key');
  });

  it('falls back to the DB tenants row when the key is not in memory', async () => {
    await testDb.db.insert(tenants).values({
      tenantKey: 'db-only-builders',
      businessName: 'DB Only Builders',
      displayName: 'DB Only',
      logoUrl: '',
      accentColor: '#123456',
      allowedOrigins: ['https://dbonly.example.com'],
      fallbackPhone: '',
      fallbackEmail: '',
      plan: 'flat',
    });
    const service = serviceWith(
      { 'elite-craft-builders': FILE_CONFIG },
      testDb.db,
    );
    const config = await service.getByKey('db-only-builders');
    expect(config.business_name).toBe('DB Only Builders');
    expect(config.plan).toBe('flat');
    expect(config.allowed_origins).toEqual(['https://dbonly.example.com']);
  });

  it('prefers the repo JSON over the DB row for the same key', async () => {
    await testDb.db.insert(tenants).values({
      tenantKey: 'elite-craft-builders',
      businessName: 'Stale DB Name',
      displayName: 'Stale DB',
      logoUrl: '',
      accentColor: '#000000',
      allowedOrigins: ['https://stale.example.com'],
      fallbackPhone: '',
      fallbackEmail: '',
      plan: 'commission',
    });
    const service = serviceWith(
      { 'elite-craft-builders': FILE_CONFIG },
      testDb.db,
    );
    const config = await service.getByKey('elite-craft-builders');
    expect(config.business_name).toBe('Elite Craft Builders');
  });

  it('throws 404 UNKNOWN_TENANT when neither has the key', async () => {
    const service = serviceWith(
      { 'elite-craft-builders': FILE_CONFIG },
      testDb.db,
    );
    const error = await service
      .getByKey('no-such-builder')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
    expect((error as HttpError).code).toBe(ErrorCodes.UNKNOWN_TENANT);
  });

  it('fails loud at startup on a broken injected config', () => {
    expect(() =>
      serviceWith({
        'broken.json': { ...FILE_CONFIG, accent_color: 'not-a-hex' },
      }),
    ).toThrow('field "accent_color"');
  });
});
