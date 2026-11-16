/**
 * Builder notification store (#725) against PGlite with every migration
 * applied (including 0055): preference defaults, upsert, the send-once
 * dedupe, the claim lease, pending-row filters and the digest builder list.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  builderMemberships,
  builders,
  estimates,
  leads,
  users,
} from '../src/db/schema';
import { createDrizzleBuilderNotificationStore } from '../src/services/builder-notification.store';
import { createTestDb, type TestDb } from './pglite-db';

const MIN = 60_000;
const T0 = new Date('2026-11-16T15:00:00Z');

let testDb: TestDb;
const builderId = randomUUID();
const otherBuilderId = randomUUID();
const adminId = randomUUID();
const memberId = randomUUID();
const disabledId = randomUUID();
const leadId = randomUUID();

beforeAll(async () => {
  testDb = await createTestDb();
  const db = testDb.db;
  await db.insert(builders).values([
    { id: builderId, tenantKey: 'elite', businessName: 'Elite Inc', displayName: 'Elite Craft Builders' },
    { id: otherBuilderId, tenantKey: 'other', businessName: 'Other Inc', displayName: 'Other Homes', status: 'inactive' },
  ]);
  await db.insert(users).values([
    { id: adminId, email: 'admin@elite.example', name: 'Admin', status: 'active' },
    { id: memberId, email: 'member@elite.example', name: 'Member', status: 'active' },
    { id: disabledId, email: 'gone@elite.example', name: 'Gone', status: 'disabled' },
  ]);
  await db.insert(builderMemberships).values([
    { id: randomUUID(), userId: adminId, builderId, role: 'builder_admin' },
    { id: randomUUID(), userId: memberId, builderId, role: 'builder_member' },
    { id: randomUUID(), userId: disabledId, builderId, role: 'builder_member' },
    { id: randomUUID(), userId: adminId, builderId: otherBuilderId, role: 'builder_admin' },
  ]);
  const estimateId = randomUUID();
  await db.insert(estimates).values({
    id: estimateId,
    projectType: 'renovation',
    addressKey: '1412 PROSPECT AV SW',
    inputs: {},
    figures: {},
    rows: [],
    costDataVersion: 'test',
  });
  await db.insert(leads).values({
    id: leadId,
    estimateId,
    addressKey: '1412 PROSPECT AV SW',
    email: 'jane@homeowner.example',
    name: 'Jane Doe',
    timeline: 'exploring',
    consentTs: T0,
    builderId,
  });
}, 60_000);

afterAll(async () => {
  await testDb.close();
});

describe('builder notification store (#725)', () => {
  it('lists active members with default preferences, by email or id', async () => {
    const store = createDrizzleBuilderNotificationStore({ db: testDb.db });
    const members = await store.listActiveMembers(builderId);
    expect(members).toEqual([
      {
        userId: adminId,
        email: 'admin@elite.example',
        role: 'builder_admin',
        preferences: { newLeadEmail: true, needsYouDigest: false, billingEmail: true },
      },
      {
        userId: memberId,
        email: 'member@elite.example',
        role: 'builder_member',
        preferences: { newLeadEmail: true, needsYouDigest: false, billingEmail: true },
      },
    ]);
    expect((await store.findActiveMember(builderId, { email: ' Member@Elite.example ' }))?.userId).toBe(memberId);
    expect((await store.findActiveMember(builderId, { userId: adminId }))?.role).toBe('builder_admin');
    expect(await store.findActiveMember(builderId, { userId: disabledId })).toBeNull();
  });

  it('upserts preferences per org and lists digest builders (active orgs only)', async () => {
    const store = createDrizzleBuilderNotificationStore({ db: testDb.db });
    expect(await store.listDigestBuilders()).toEqual([]);
    await store.savePreferences({
      userId: memberId,
      builderId,
      preferences: { newLeadEmail: false, needsYouDigest: true, billingEmail: true },
      at: T0,
    });
    await store.savePreferences({
      userId: adminId,
      builderId: otherBuilderId,
      preferences: { newLeadEmail: true, needsYouDigest: true, billingEmail: true },
      at: T0,
    });
    const member = await store.findActiveMember(builderId, { userId: memberId });
    expect(member?.preferences).toEqual({ newLeadEmail: false, needsYouDigest: true, billingEmail: true });
    // Saving again updates in place.
    await store.savePreferences({
      userId: memberId,
      builderId,
      preferences: { newLeadEmail: true, needsYouDigest: true, billingEmail: false },
      at: T0,
    });
    expect((await store.findActiveMember(builderId, { userId: memberId }))?.preferences.newLeadEmail).toBe(true);
    // The other org is inactive, so only Elite is listed.
    expect((await store.listDigestBuilders()).map((b) => b.id)).toEqual([builderId]);
  });

  it('reads the lead with its estimate project type', async () => {
    const store = createDrizzleBuilderNotificationStore({ db: testDb.db });
    expect(await store.findLead(leadId)).toEqual({
      id: leadId,
      name: 'Jane Doe',
      builderId,
      quarantined: false,
      discarded: false,
      sandbox: false,
      addressKey: '1412 PROSPECT AV SW',
      projectType: 'renovation',
    });
    expect(await store.findLead(randomUUID())).toBeNull();
  });

  it('enqueue is send-once per dedupe key; claim holds a lease', async () => {
    const store = createDrizzleBuilderNotificationStore({ db: testDb.db });
    const row = {
      id: randomUUID(),
      dedupeKey: `new_lead:${leadId}:${builderId}:${adminId}`,
      kind: 'new_lead' as const,
      builderId,
      userId: adminId,
      leadId,
    };
    await store.enqueue([row]);
    await store.enqueue([{ ...row, id: randomUUID() }]);
    const window = {
      createdAfter: new Date(Date.now() - 60 * MIN),
      leaseCutoff: new Date(Date.now() - 10 * MIN),
      maxAttempts: 3,
      limit: 10,
    };
    const pending = await store.listPending({ ...window, leadId });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: row.id, kind: 'new_lead', status: 'pending', attempts: 0 });

    const now = new Date();
    expect(await store.claim({ id: row.id, now, leaseCutoff: new Date(now.getTime() - 10 * MIN) })).toBe(true);
    // A second worker inside the lease can't claim it, and it isn't listed.
    expect(await store.claim({ id: row.id, now, leaseCutoff: new Date(now.getTime() - 10 * MIN) })).toBe(false);
    expect(await store.listPending({ ...window, leaseCutoff: new Date(now.getTime() - 10 * MIN) })).toHaveLength(0);

    // A failure releases the lease for the next tick; the attempt counts.
    await store.recordFailure({ id: row.id, errorCode: 'delivery-failed' });
    const again = await store.listPending({ ...window, leadId });
    expect(again[0]?.attempts).toBe(1);
    expect(await store.listPending({ ...window, maxAttempts: 1 })).toHaveLength(0);

    await store.finish({ id: row.id, status: 'sent', at: now });
    expect(await store.listPending({ ...window, leadId })).toHaveLength(0);
    expect(await store.claim({ id: row.id, now, leaseCutoff: now })).toBe(false);
    const stored = await testDb.rows<{ status: string; processed_at: Date | null }>(
      `select status, processed_at from builder_notifications where id = '${row.id}'`,
    );
    expect(stored[0]?.status).toBe('sent');
    expect(stored[0]?.processed_at).not.toBeNull();
  });

  it('erasing the lead removes its outbox rows (ON DELETE CASCADE)', async () => {
    const store = createDrizzleBuilderNotificationStore({ db: testDb.db });
    await testDb.exec(`delete from leads where id = '${leadId}'`);
    const rows = await testDb.rows<{ n: number }>(
      `select count(*)::int as n from builder_notifications where lead_id = '${leadId}'`,
    );
    expect(rows[0]?.n).toBe(0);
    expect(await store.findLead(leadId)).toBeNull();
  });
});
