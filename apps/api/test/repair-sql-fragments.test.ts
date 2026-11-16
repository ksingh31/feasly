/**
 * #900: repair-sql blocks live in tools/repair-sql.d/ so parallel branches
 * never conflict on the end of one big string. That only works if the
 * fragments are order-independent: each one idempotent and depending only on
 * the migrations + the core, never on another fragment. Proven here on a
 * real (PGlite) database by applying them in reverse order, then again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error: plain .mjs module without type declarations
import { REPAIR_CORE_SQL, REPAIR_FRAGMENTS, REPAIR_SQL } from '../tools/repair-sql.mjs';
import { createTestDb, type TestDb } from './pglite-db';

interface Fragment {
  name: string;
  sql: string;
}
const fragments = REPAIR_FRAGMENTS as Fragment[];
const core = REPAIR_CORE_SQL as string;
const full = REPAIR_SQL as string;

describe('repair-sql fragments (#900)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  it('loads every tools/repair-sql.d/*.sql file, sorted, into REPAIR_SQL after the core', () => {
    const onDisk = readdirSync(join(__dirname, '..', 'tools', 'repair-sql.d'))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(fragments.map((f) => f.name)).toEqual(onDisk);
    expect(full.startsWith(core)).toBe(true);
    for (const f of fragments) {
      expect(f.name).toMatch(/^\d+-[a-z0-9-]+\.sql$/);
      expect(full).toContain(f.sql);
    }
  });

  it('fragments apply in reverse order and re-apply cleanly (order-independent + idempotent)', async () => {
    await t.exec(core);
    for (const f of [...fragments].reverse()) await t.exec(f.sql);
    await t.exec(full);
    await t.exec(full);
  });
});
