/**
 * Lead comments store tests (BILL-05).
 *
 * The store runs against PGlite with the real migrations applied
 * (including 0044_builder_comments) — no fakes below the service layer.
 *
 * The critical assertion: `listByEntity({ includeAdminOnly: false })`
 * excludes `admin_only` rows IN SQL. The test inserts an admin_only row
 * and an org row, then reads with the builder flag — if anyone ever moves
 * the visibility filter from the WHERE clause into JS (or drops it), the
 * internal note leaks into the result and this test fails.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createDrizzleCommentStore } from '../src/services/builder-comments.store';
import { createTestDb, type TestDb } from './pglite-db';

const AUTHOR_ID = 'd1111111-1111-4111-8111-111111111111';

describe('builder comments store (PGlite)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  async function seed() {
    const store = createDrizzleCommentStore({ db: testDb.db });
    const now = new Date();
    // Fresh entity per test — the PGlite database is shared across tests
    // in this file, so rows must not leak between cases.
    const entityId = randomUUID();
    const org = await store.insert({
      id: randomUUID(),
      entityType: 'lead',
      entityId,
      authorKind: 'builder',
      authorId: AUTHOR_ID,
      visibility: 'org',
      body: 'builder-visible note',
      createdAt: now,
      updatedAt: now,
    });
    const internal = await store.insert({
      id: randomUUID(),
      entityType: 'lead',
      entityId,
      authorKind: 'admin',
      authorId: AUTHOR_ID,
      visibility: 'admin_only',
      body: 'internal only',
      createdAt: now,
      updatedAt: now,
    });
    return { store, org, internal, entityId };
  }

  it('creates the builder_comments table with the visibility indexes', async () => {
    const tables = await testDb.rows<{ table_name: string }>(
      `select table_name from information_schema.tables ` +
        `where table_schema = 'public' and table_name = 'builder_comments'`,
    );
    expect(tables.map((r) => r.table_name)).toEqual(['builder_comments']);
    const indexes = await testDb.rows<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' ` +
        `and tablename = 'builder_comments'`,
    );
    const names = indexes.map((r) => r.indexname);
    expect(names).toContain('builder_comments_entity_idx');
    expect(names).toContain('builder_comments_entity_visibility_idx');
  });

  it('excludes admin_only rows in SQL when includeAdminOnly=false', async () => {
    const { store, org, entityId } = await seed();
    const rows = await store.listByEntity({
      entityType: 'lead',
      entityId,
      includeAdminOnly: false,
    });
    expect(rows.map((r) => r.id)).toEqual([org.id]);
    expect(rows.every((r) => r.visibility === 'org')).toBe(true);
  });

  it('returns the full thread when includeAdminOnly=true', async () => {
    const { store, org, internal, entityId } = await seed();
    const rows = await store.listByEntity({
      entityType: 'lead',
      entityId,
      includeAdminOnly: true,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(
      [org.id, internal.id].sort(),
    );
  });

  it('excludes soft-deleted rows from both read paths', async () => {
    const { store, org, internal, entityId } = await seed();
    await store.softDelete({ id: org.id, deletedAt: new Date() });
    const builderRows = await store.listByEntity({
      entityType: 'lead',
      entityId,
      includeAdminOnly: false,
    });
    const adminRows = await store.listByEntity({
      entityType: 'lead',
      entityId,
      includeAdminOnly: true,
    });
    expect(builderRows).toHaveLength(0);
    expect(adminRows.map((r) => r.id)).toEqual([internal.id]);
    // The row itself survives (soft delete, never hard).
    expect(await store.getById(org.id)).not.toBeNull();
  });

  it('updateBody rewrites the body and bumps updated_at', async () => {
    const { store, org } = await seed();
    const later = new Date(org.updatedAt.getTime() + 60_000);
    const updated = await store.updateBody({
      id: org.id,
      body: 'revised',
      updatedAt: later,
    });
    expect(updated?.body).toBe('revised');
    expect(updated?.updatedAt.getTime()).toBe(later.getTime());
  });
});

describe('builder comments store summariesByEntity (PGlite)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  async function insertNote(args: {
    entityId: string;
    authorKind: 'builder' | 'admin';
    visibility: 'org' | 'admin_only';
    body: string;
    createdAt: Date;
  }) {
    const store = createDrizzleCommentStore({ db: testDb.db });
    return store.insert({
      id: randomUUID(),
      entityType: 'lead',
      entityId: args.entityId,
      authorKind: args.authorKind,
      authorId: AUTHOR_ID,
      visibility: args.visibility,
      body: args.body,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
    });
  }

  it('returns per-entity counts and the newest visible comment in one call', async () => {
    const base = new Date('2026-09-28T10:00:00.000Z');
    const entityA = randomUUID();
    await insertNote({
      entityId: entityA, authorKind: 'builder', visibility: 'org',
      body: 'First', createdAt: new Date(base.getTime()),
    });
    await insertNote({
      entityId: entityA, authorKind: 'builder', visibility: 'org',
      body: 'Second', createdAt: new Date(base.getTime() + 1_000),
    });
    // Newest overall is admin_only: builder callers must not see it.
    await insertNote({
      entityId: entityA, authorKind: 'admin', visibility: 'admin_only',
      body: 'Secret', createdAt: new Date(base.getTime() + 2_000),
    });
    // A second entity with a single note proves per-entity partitioning.
    const entityB = randomUUID();
    await insertNote({
      entityId: entityB, authorKind: 'builder', visibility: 'org',
      body: 'Only', createdAt: new Date(base.getTime()),
    });

    const store = createDrizzleCommentStore({ db: testDb.db });
    const builderView = await store.summariesByEntity({
      entityType: 'lead',
      entityIds: [entityA, entityB, randomUUID()],
      includeAdminOnly: false,
    });
    // The entity with zero visible comments is absent from the map.
    expect([...builderView.keys()].sort()).toEqual([entityA, entityB].sort());

    const summaryA = builderView.get(entityA)!;
    expect(summaryA.count).toBe(2);
    expect(summaryA.latest?.body).toBe('Second');
    expect(summaryA.latest?.authorId).toBe(AUTHOR_ID);
    expect(summaryA.latest?.createdAt.getTime()).toBe(base.getTime() + 1_000);

    const summaryB = builderView.get(entityB)!;
    expect(summaryB.count).toBe(1);
    expect(summaryB.latest?.body).toBe('Only');

    const adminView = await store.summariesByEntity({
      entityType: 'lead',
      entityIds: [entityA],
      includeAdminOnly: true,
    });
    expect(adminView.get(entityA)?.count).toBe(3);
    expect(adminView.get(entityA)?.latest?.body).toBe('Secret');
  });

  it('excludes soft-deleted comments from the count and the latest', async () => {
    const base = new Date('2026-09-28T10:00:00.000Z');
    const entityId = randomUUID();
    await insertNote({
      entityId, authorKind: 'builder', visibility: 'org',
      body: 'First', createdAt: new Date(base.getTime()),
    });
    const newest = await insertNote({
      entityId, authorKind: 'builder', visibility: 'org',
      body: 'Second', createdAt: new Date(base.getTime() + 1_000),
    });

    const store = createDrizzleCommentStore({ db: testDb.db });
    await store.softDelete({ id: newest.id, deletedAt: new Date() });

    const view = await store.summariesByEntity({
      entityType: 'lead',
      entityIds: [entityId],
      includeAdminOnly: false,
    });
    expect(view.get(entityId)?.count).toBe(1);
    expect(view.get(entityId)?.latest?.body).toBe('First');
  });

  it('returns an empty map for an empty entity list', async () => {
    const store = createDrizzleCommentStore({ db: testDb.db });
    const view = await store.summariesByEntity({
      entityType: 'lead',
      entityIds: [],
      includeAdminOnly: false,
    });
    expect(view.size).toBe(0);
  });
});
