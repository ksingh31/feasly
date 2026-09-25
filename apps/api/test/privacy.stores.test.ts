/**
 * Privacy Drizzle store integration tests (legal/02).
 *
 * Runs the real migration SQL (including 0001_lucky_tiger.sql) against an
 * in-process Postgres (PGlite), then exercises the real store
 * implementations: magic-link issue/find/revoke, privacy store CRUD and
 * audit, and the new lead store methods (findById, findAllByEmail,
 * deleteByEmail). No fakes below the service layer here.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  createDrizzleMagicLinkStore,
  hashMagicToken,
} from '../src/services/magic-link.store';
import { createDrizzlePrivacyStore } from '../src/services/privacy.store';
import { createDrizzleLeadStore } from '../src/services/lead.store';
import { createDrizzleEstimateStore } from '../src/services/estimate.store';
import { hashEmail } from '../src/services/privacy.service';
import { createTestDb, type TestDb } from './pglite-db';

const NOW = new Date('2026-09-24T12:00:00Z');
const LEAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ESTIMATE_ID = 'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function seedLeadAndEstimate(testDb: TestDb): Promise<void> {
  const estimates = createDrizzleEstimateStore({ db: testDb.db });
  await estimates.save({
    id: ESTIMATE_ID,
    addressKey: 'calgary-123-fake-st-nw',
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'v0.1.0-unclibrated',
    projectType: 'new_build',
    createdAt: NOW,

    narrative: null,
    narrativeGeneratedAt: null,
    assumptions: null,
  });
  const leads = createDrizzleLeadStore({ db: testDb.db });
  await leads.insert({
    id: LEAD_ID,
    estimateId: ESTIMATE_ID,
    addressKey: 'calgary-123-fake-st-nw',
    email: 'alice@example.com',
    name: 'Alice',
    timeline: 'exploring',
    marketingConsent: false,
    consentTs: NOW,
    source: 'api',
  });
}

describe('privacy tables (migration 0003)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('creates magic_links, erasure_requests and privacy_audit_log', async () => {
    const rows = await testDb.rows<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('magic_links', 'erasure_requests', 'privacy_audit_log')`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      'erasure_requests',
      'magic_links',
      'privacy_audit_log',
    ]);
  });

  it('enforces unique token hashes and SET NULL foreign keys', async () => {
    const unique = await testDb.rows<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'magic_links' and indexname = 'magic_links_token_hash_unique'`,
    );
    expect(unique).toHaveLength(1);
    const fk = await testDb.rows<{
      conname: string;
      confdeltype: string;
    }>(
      `select c.conname, c.confdeltype from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname = 'magic_links' and c.contype = 'f'`,
    );
    // Only one FK exists on magic_links: lead_id -> leads (SET NULL).
    // There is no users table yet (identity is the lead's email until
    // BE-4's session model lands), so exactly one 'n' (SET NULL) row.
    expect(fk.map((r) => r.confdeltype).sort()).toEqual(['n']);
  });
});

describe('magic-link store', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
    await seedLeadAndEstimate(testDb);
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('issues a link whose raw token verifies (hash-only storage)', async () => {
    const store = createDrizzleMagicLinkStore({ db: testDb.db });
    const issued = await store.issue({
      leadId: LEAD_ID,
      ttlSeconds: 7 * 86_400,
      clock: () => NOW,
    });
    expect(issued.token).toHaveLength(64);

    // The bearer token resolves to its row; unknown tokens resolve to null.
    // Expiry/revocation is the CALLER's decision (uniform denial, no oracle).
    const found = await store.findByToken(issued.token);
    expect(found?.id).toBe(issued.id);
    expect(found?.purpose).toBe('lead');
    expect(found?.leadId).toBe(LEAD_ID);
    expect(found?.revokedAt).toBeNull();
    expect(await store.findByToken('bogus-token')).toBeNull();

    // Hash-only storage: the DB holds the SHA-256 hex, never the raw token.
    const rows = await testDb.rows<{ token_hash: string }>(
      `select token_hash from magic_links where id = '${issued.id}'`,
    );
    expect(rows[0]!.token_hash).toBe(hashMagicToken(issued.token));
    expect(rows[0]!.token_hash).not.toBe(issued.token);
  });

  it('revokes all links for a set of lead ids', async () => {
    // A dedicated lead keeps this test isolated from the issue test above
    // (both share one DB per describe block).
    const OTHER_LEAD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const leads = createDrizzleLeadStore({ db: testDb.db });
    await leads.insert({
      id: OTHER_LEAD_ID,
      estimateId: ESTIMATE_ID,
      addressKey: 'calgary-123-fake-st-nw',
      email: 'bob@example.com',
      name: 'Bob',
      timeline: 'exploring',
      marketingConsent: false,
      consentTs: NOW,
      source: 'api',
    });
    const store = createDrizzleMagicLinkStore({ db: testDb.db });
    const first = await store.issue({
      leadId: OTHER_LEAD_ID,
      ttlSeconds: 3600,
      clock: () => NOW,
    });
    const second = await store.issue({
      leadId: OTHER_LEAD_ID,
      ttlSeconds: 3600,
      clock: () => NOW,
    });
    const n = await store.revokeByLeadIds([OTHER_LEAD_ID], NOW);
    expect(n).toBe(2);
    // Revocation stamps revoked_at; findByToken still resolves the row —
    // the caller (PrivacyService) rejects revoked links uniformly.
    const after = await store.findByToken(first.token);
    expect(after?.revokedAt).toEqual(NOW);
    expect(
      (await store.findByToken(second.token))?.revokedAt,
    ).toEqual(NOW);
    expect(
      await store.findByLeadIds([OTHER_LEAD_ID]),
    ).toHaveLength(2);
    // Idempotent: already-revoked links are not counted twice.
    expect(await store.revokeByLeadIds([OTHER_LEAD_ID], NOW)).toBe(0);
  });
});

describe('privacy store', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
    await seedLeadAndEstimate(testDb);
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('round-trips erasure requests: create → findLatest → markCompleted', async () => {
    const store = createDrizzlePrivacyStore({ db: testDb.db });
    const emailHash = hashEmail('alice@example.com');
    const created = await store.createRequest({
      leadId: LEAD_ID,
      emailHash,
    });
    expect(created.status).toBe('requested');
    expect(await store.findById(created.id)).not.toBeNull();
    const latest = await store.findLatestByEmailHash(emailHash);
    expect(latest?.id).toBe(created.id);
    const completed = await store.markCompleted(created.id, NOW);
    expect(completed.status).toBe('completed');
    expect(completed.confirmedAt).toEqual(NOW);
  });

  it('writes PII-free audit rows', async () => {
    const store = createDrizzlePrivacyStore({ db: testDb.db });
    await store.audit({
      leadId: LEAD_ID,
      action: 'export',
      detail: 'privacy export via API',
    });
    const rows = await testDb.rows<{ action: string; lead_id: string }>(
      `select action, lead_id from privacy_audit_log`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('export');
    expect(rows[0]!.lead_id).toBe(LEAD_ID);
  });
});

describe('lead store privacy methods', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
    await seedLeadAndEstimate(testDb);
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('findById / findAllByEmail / deleteByEmail', async () => {
    const store = createDrizzleLeadStore({ db: testDb.db });
    const byId = await store.findById(LEAD_ID);
    expect(byId?.email).toBe('alice@example.com');
    expect(await store.findById('ffffffff-ffff-4fff-8fff-ffffffffffff')).toBeNull();
    expect(
      (await store.findAllByEmail('alice@example.com')).map((l) => l.id),
    ).toEqual([LEAD_ID]);
    expect(await store.deleteByEmail('alice@example.com')).toBe(1);
    expect(await store.findById(LEAD_ID)).toBeNull();
  });
});
