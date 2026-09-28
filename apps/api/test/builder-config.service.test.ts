/**
 * Builder-config service tests (EMB-02, builders table).
 *
 * Resolution order (embed/02 admin-UI migration): DB `builders` row first
 * (the runtime source of truth), repo JSON (`config/builders/*.json`)
 * as the fallback when no DB row exists. Unknown key → 404
 * UNKNOWN_TENANT. Inactive DB builders → 404 (they can't embed).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createBuilderConfigService,
  type BuilderConfigService,
} from '../src/services/builder-config.service';
import { builders } from '../src/db/schema';
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

const QUIET = { onWarning: () => {} };

function serviceWith(
  configs: Record<string, unknown>,
  db: AppDb,
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

  it('serves the DB builders row first (DB is the source of truth)', async () => {
    await testDb.db.insert(builders).values({
      id: '11111111-1111-4111-8111-111111111111',
      tenantKey: 'db-builders',
      businessName: 'DB Builders',
      displayName: 'DB',
      email: '',
      phone: '',
      logoUrl: '',
      accentColor: '#123456',
      allowedOrigins: ['https://db.example.com'],
      plan: 'flat',
      status: 'active',
      settings: {},
    });
    const service = serviceWith(
      { 'elite-craft-builders': FILE_CONFIG },
      testDb.db,
    );
    const config = await service.getByKey('db-builders');
    expect(config.business_name).toBe('DB Builders');
    expect(config.plan).toBe('flat');
    expect(config.allowed_origins).toEqual(['https://db.example.com']);
  });

  it('prefers the DB builders row over the repo JSON for the same key', async () => {
    await testDb.db.insert(builders).values({
      id: '22222222-2222-4222-8222-222222222222',
      tenantKey: 'db-wins-builder',
      businessName: 'DB Wins Builder',
      displayName: 'DB Wins',
      email: '',
      phone: '',
      logoUrl: '',
      accentColor: '#000000',
      allowedOrigins: ['https://db.example.com'],
      plan: 'commission',
      status: 'active',
      settings: {},
    });
    const service = serviceWith(
      {
        'db-wins-builder': {
          ...FILE_CONFIG,
          tenant_key: 'db-wins-builder',
          business_name: 'Stale JSON Name',
        },
      },
      testDb.db,
    );
    const config = await service.getByKey('db-wins-builder');
    // DB wins — the JSON is only a fallback when no DB row exists.
    expect(config.business_name).toBe('DB Wins Builder');
  });

  it('falls back to the repo JSON when the DB has no row', async () => {
    const service = serviceWith(
      { 'elite-craft-builders': FILE_CONFIG },
      testDb.db,
    );
    // 'json-only-builder' has no DB row — the JSON fallback serves it.
    const serviceWithJson = serviceWith(
      { 'json-only-builder': { ...FILE_CONFIG, tenant_key: 'json-only-builder' } },
      testDb.db,
    );
    const config = await serviceWithJson.getByKey('json-only-builder');
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
    expect(service).toBeDefined();
  });

  it('rejects an inactive DB builder as unknown (404)', async () => {
    await testDb.db.insert(builders).values({
      id: '33333333-3333-4333-8333-333333333333',
      tenantKey: 'inactive-builder',
      businessName: 'Inactive Builder',
      displayName: 'Inactive',
      email: '',
      phone: '',
      logoUrl: '',
      accentColor: '#000000',
      allowedOrigins: [],
      plan: null,
      status: 'inactive',
      settings: {},
    });
    const service = serviceWith({}, testDb.db);
    const error = await service
      .getByKey('inactive-builder')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
    expect((error as HttpError).code).toBe(ErrorCodes.UNKNOWN_TENANT);
  });

  it('throws 404 UNKNOWN_TENANT when neither DB nor JSON has the key', async () => {
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
      serviceWith(
        {
          'broken.json': { ...FILE_CONFIG, accent_color: 'not-a-hex' },
        },
        testDb.db,
      ),
    ).toThrow('field "accent_color"');
  });

  it('resolves the committed demo.json repo config (QA tenant)', async () => {
    // Reads the real file — this pins the QA/demo tenant end to end:
    // a broken or missing demo.json fails here, not silently in a preview.
    const raw = readFileSync(
      join(__dirname, '..', '..', '..', 'config', 'builders', 'demo.json'),
      'utf8',
    );
    const data = JSON.parse(raw) as Record<string, unknown>;
    // No 'demo' row in the DB — the JSON fallback serves it.
    const service = serviceWith({ demo: data }, testDb.db);
    const config = await service.getByKey('demo');
    expect(config).toEqual({
      business_name: 'Demo Builder',
      display_name: 'Demo Builder',
      logo_url: '',
      accent_color: '#0F766E',
      allowed_origins: ['https://demo.example.com'],
      fallback_phone: '(555) 010-2030',
      fallback_email: 'demo@example.com',
      plan: null,
    });
    // tenant_key is internal — never on the wire.
    expect(config).not.toHaveProperty('tenant_key');
  });
});
