/**
 * #725 AC2 — an admin assigning a lead to a builder fires the new-lead
 * notification hook for that builder; unassigning or re-assigning to the
 * same builder does not. PGlite with every migration applied.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builders, estimates, leads } from '../src/db/schema';
import { createBuilderService } from '../src/services/builder.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';
import { createTestDb, type TestDb } from './pglite-db';

let testDb: TestDb;
const builderA = randomUUID();
const builderB = randomUUID();
const leadId = randomUUID();

beforeAll(async () => {
  testDb = await createTestDb();
  await testDb.db.insert(builders).values([
    { id: builderA, tenantKey: 'a', businessName: 'A Inc', displayName: 'A' },
    { id: builderB, tenantKey: 'b', businessName: 'B Inc', displayName: 'B' },
  ]);
  const estimateId = randomUUID();
  await testDb.db.insert(estimates).values({
    id: estimateId,
    addressKey: 'x',
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'test',
  });
  await testDb.db.insert(leads).values({
    id: leadId,
    estimateId,
    addressKey: 'x',
    email: 'h@example.com',
    name: 'H',
    timeline: 'exploring',
    consentTs: new Date(),
    builderId: builderA,
  });
}, 60_000);

afterAll(async () => {
  await testDb.close();
});

describe('assignLead → new-lead notification (#725)', () => {
  it('notifies only when the lead moves to a different builder', async () => {
    const calls: Array<{ leadId: string; builderId: string }> = [];
    const audit = { log: async () => {} } as unknown as AdminAuditStore;
    const service = createBuilderService({
      db: testDb.db,
      audit,
      onLeadAssigned: async (args) => {
        calls.push(args);
      },
    });
    await service.assignLead(leadId, builderA, 'admin@example.com'); // same builder
    await service.assignLead(leadId, builderB, 'admin@example.com'); // reassigned
    await service.assignLead(leadId, null, 'admin@example.com'); // unassigned
    expect(calls).toEqual([{ leadId, builderId: builderB }]);
  });
});
