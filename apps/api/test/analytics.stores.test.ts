/**
 * Analytics Drizzle store integration test (story consumer/01).
 *
 * Runs the real migration SQL (including 0004_chubby_la_nuit.sql) against an
 * in-process Postgres (PGlite), then exercises the real store: insert one
 * event and read it back raw, asserting the row carries exactly the closed
 * payload shape — no PII columns exist to leak into.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createDrizzleAnalyticsStore } from '../src/services/analytics.store';
import { EMPTY_CAMPAIGN_SOURCE } from '../src/lib/campaign-source';
import { createTestDb, type TestDb } from './pglite-db';

describe('analytics store (PGlite)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('appends an event and the stored row has no PII columns', async () => {
    const store = createDrizzleAnalyticsStore({ db: testDb.db });
    const record = await store.insert({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      event: 'gate_convert',
      route: '/estimate/gate',
      ts: new Date('2026-09-25T12:00:00.000Z'),
      consentTs: new Date('2026-09-25T11:59:00.000Z'),
      tenantKey: null,
      source: EMPTY_CAMPAIGN_SOURCE,
    });
    expect(record.event).toBe('gate_convert');
    expect(record.route).toBe('/estimate/gate');
    expect(record.consentTs.toISOString()).toBe('2026-09-25T11:59:00.000Z');
    expect(record.createdAt).toBeInstanceOf(Date);

    // The raw row proves the closed shape: the only columns are the
    // contract fields (incl. the #814 campaign-source fields and the #870
    // embed origin — a bare https origin, never a page URL) + the sandbox
    // flag — email/name/address cannot be stored.
    const rows = await testDb.rows<Record<string, unknown>>(
      `select * from analytics_events where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`,
    );
    expect(rows).toHaveLength(1);
    const keys = Object.keys(rows[0]).sort();
    expect(keys).toEqual([
      'click_id_type',
      'consent_ts',
      'created_at',
      'embed_origin',
      'event',
      'id',
      'route',
      'sandbox',
      'tenant_key',
      'ts',
      'utm_campaign',
      'utm_content',
      'utm_medium',
      'utm_source',
      'utm_term',
    ]);
  });

  it('stores and returns campaign source fields (#814)', async () => {
    const store = createDrizzleAnalyticsStore({ db: testDb.db });
    const source = {
      ...EMPTY_CAMPAIGN_SOURCE,
      utmSource: 'google',
      utmCampaign: 'spring-infill',
      clickIdType: 'gclid' as const,
    };
    const record = await store.insert({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      event: 'landing_view',
      route: '/',
      ts: new Date('2026-09-25T12:00:00.000Z'),
      consentTs: new Date('2026-09-25T11:59:00.000Z'),
      tenantKey: null,
      source,
    });
    expect(record.source).toEqual(source);
    const rows = await testDb.rows<Record<string, unknown>>(
      `select utm_source, utm_campaign, click_id_type, utm_term from analytics_events where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'`,
    );
    expect(rows[0]).toEqual({
      utm_source: 'google',
      utm_campaign: 'spring-infill',
      click_id_type: 'gclid',
      utm_term: null,
    });
  });

  it('creates the analytics_events lookup index', async () => {
    const idx = await testDb.rows<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'analytics_events'`,
    );
    expect(idx.map((r) => r.indexname)).toContain('analytics_events_event_created_idx');
    expect(idx.map((r) => r.indexname)).toContain('analytics_events_source_created_idx');
  });
});
