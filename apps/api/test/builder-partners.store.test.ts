/**
 * Builder partner store integration (#888): migration 0055 against PGlite —
 * the Elite Craft Builders seed, active-only filter in SQL, display order,
 * insert/update round-trip — and the repair SQL re-run being a no-op that
 * never overwrites an admin's edit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleBuilderPartnerStore } from '../src/services/builder-partners.store';
// @ts-expect-error: plain .mjs module without type declarations
import { REPAIR_SQL } from '../tools/repair-sql.mjs';
import { createTestDb, type TestDb } from './pglite-db';

const SEED_ID = '3fc7bb9f-e00b-4028-9255-e01730fd17c9';
const ELITE_BUILDER_ID = 'a506cc36-ffd1-42db-993c-999bfbb0f1d2';

describe('builder partner store (#888)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('seeds Elite Craft Builders as the current, active partner', async () => {
    const store = createDrizzleBuilderPartnerStore({ db: testDb.db });
    const active = await store.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      id: SEED_ID,
      name: 'Elite Craft Builders',
      websiteUrl: 'https://elitecraftbuilders.com',
      builderId: ELITE_BUILDER_ID,
      active: true,
      displayOrder: 0,
    });
  });

  it('lists active only (in SQL), in display order then name; admin list has all', async () => {
    const store = createDrizzleBuilderPartnerStore({ db: testDb.db });
    const base = {
      builderId: null,
      logoUrl: null,
      websiteUrl: null,
      description: null,
    };
    await store.insert({ ...base, id: '11111111-1111-4111-8111-111111111111', name: 'Zeta', displayOrder: 1, active: true });
    await store.insert({ ...base, id: '22222222-2222-4222-8222-222222222222', name: 'Alpha', displayOrder: 1, active: true });
    await store.insert({ ...base, id: '33333333-3333-4333-8333-333333333333', name: 'Off', displayOrder: 0, active: false });

    expect((await store.listActive()).map((r) => r.name)).toEqual([
      'Elite Craft Builders',
      'Alpha',
      'Zeta',
    ]);
    expect((await store.listAll()).map((r) => r.name)).toEqual([
      'Elite Craft Builders',
      'Off',
      'Alpha',
      'Zeta',
    ]);
    expect(await store.maxDisplayOrder()).toBe(1);
  });

  it('updates a row and bumps updated_at; null for an unknown id', async () => {
    const store = createDrizzleBuilderPartnerStore({ db: testDb.db });
    const before = await store.get('11111111-1111-4111-8111-111111111111');
    const updated = await store.update('11111111-1111-4111-8111-111111111111', {
      active: false,
      displayOrder: 7,
    });
    expect(updated).toMatchObject({ active: false, displayOrder: 7 });
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
    expect(
      await store.update('44444444-4444-4444-8444-444444444444', { active: false }),
    ).toBeNull();
  });

  it('builderExists checks the builders table', async () => {
    const store = createDrizzleBuilderPartnerStore({ db: testDb.db });
    expect(await store.builderExists(ELITE_BUILDER_ID)).toBe(true);
    expect(await store.builderExists('55555555-5555-4555-8555-555555555555')).toBe(false);
  });

  it('repair SQL re-run is a no-op and keeps an admin edit to the seed row', async () => {
    const store = createDrizzleBuilderPartnerStore({ db: testDb.db });
    await store.update(SEED_ID, { displayOrder: 3 });
    await testDb.exec(REPAIR_SQL as string);
    expect((await store.get(SEED_ID))?.displayOrder).toBe(3);
    const rows = await testDb.rows<{ n: number }>(
      `select count(*)::int as n from builder_partners where id = '${SEED_ID}'`,
    );
    expect(rows[0]!.n).toBe(1);
  });
});
