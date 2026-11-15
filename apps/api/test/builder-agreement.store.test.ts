/**
 * Agreement + onboarding Drizzle stores (#722) against PGlite with the real
 * migrations applied (proves migration 0052 and the queries agree).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createDrizzleBuilderAgreementStore,
  createDrizzleBuilderOnboardingStore,
} from '../src/services/builder-agreement.store';
import {
  analyticsEvents,
  builderMemberships,
  builders,
  estimates,
  invitations,
  leads,
  users,
} from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

const BUILDER_ID = randomUUID();
const OTHER_BUILDER_ID = randomUUID();
const ADMIN_ID = randomUUID();
const MEMBER_ID = randomUUID();

describe('builder agreement + onboarding stores (#722)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    await testDb.db.insert(builders).values([
      { id: BUILDER_ID, tenantKey: 'agree-co', businessName: 'Agree Co', displayName: 'Agree' },
      { id: OTHER_BUILDER_ID, tenantKey: 'other-co', businessName: 'Other Co', displayName: 'Other' },
    ]);
    await testDb.db.insert(users).values([
      { id: ADMIN_ID, email: 'admin@agree.example', name: 'Agree Admin', status: 'active' },
      { id: MEMBER_ID, email: 'member@agree.example', name: 'Agree Member', status: 'active' },
    ]);
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('exposes insert + reads only (append-only record)', () => {
    const store = createDrizzleBuilderAgreementStore({ db: testDb.db });
    expect(Object.keys(store).sort()).toEqual(
      ['findLatest', 'hasAcceptanceForTenant', 'insert'].sort(),
    );
  });

  it('round-trips acceptances; latest per version; tenant lookup joins builders', async () => {
    const store = createDrizzleBuilderAgreementStore({ db: testDb.db });
    expect(await store.findLatest(BUILDER_ID)).toBeNull();
    expect(await store.hasAcceptanceForTenant('agree-co', 'v1')).toBe(false);

    await store.insert({
      id: randomUUID(),
      builderId: BUILDER_ID,
      version: 'v1',
      acceptedAt: new Date('2026-11-01T10:00:00Z'),
      acceptedByUserId: ADMIN_ID,
      acceptedByEmail: 'admin@agree.example',
      ip: '203.0.113.7',
      userAgent: 'UA/1',
    });
    await store.insert({
      id: randomUUID(),
      builderId: BUILDER_ID,
      version: 'v2',
      acceptedAt: new Date('2026-12-01T10:00:00Z'),
      acceptedByUserId: ADMIN_ID,
      acceptedByEmail: 'admin@agree.example',
      ip: null,
      userAgent: null,
    });

    const latest = await store.findLatest(BUILDER_ID);
    expect(latest).toMatchObject({
      version: 'v2',
      acceptedByUserId: ADMIN_ID,
      acceptedByEmail: 'admin@agree.example',
      acceptedByName: 'Agree Admin',
    });
    expect((await store.findLatest(BUILDER_ID, 'v1'))?.acceptedAt.toISOString()).toBe(
      '2026-11-01T10:00:00.000Z',
    );
    expect(await store.hasAcceptanceForTenant('agree-co', 'v1')).toBe(true);
    expect(await store.hasAcceptanceForTenant('agree-co', 'v3')).toBe(false);
    expect(await store.hasAcceptanceForTenant('other-co', 'v1')).toBe(false);

    const raw = await testDb.rows<{ ip: string | null; user_agent: string | null }>(
      `select ip, user_agent from builder_agreement_acceptances where version = 'v1'`,
    );
    expect(raw).toEqual([{ ip: '203.0.113.7', user_agent: 'UA/1' }]);
  });

  it('onboarding: member count, pending invitations, embed signal', async () => {
    const store = createDrizzleBuilderOnboardingStore({ db: testDb.db });
    const now = new Date('2026-11-15T00:00:00Z');

    expect(await store.countMembers(BUILDER_ID)).toBe(0);
    await testDb.db.insert(builderMemberships).values([
      { id: randomUUID(), userId: ADMIN_ID, builderId: BUILDER_ID, role: 'builder_admin' },
      { id: randomUUID(), userId: MEMBER_ID, builderId: BUILDER_ID, role: 'builder_member' },
    ]);
    expect(await store.countMembers(BUILDER_ID)).toBe(2);

    expect(await store.hasPendingInvitation(OTHER_BUILDER_ID, now)).toBe(false);
    await testDb.db.insert(invitations).values({
      id: randomUUID(),
      email: 'expired@other.example',
      role: 'builder_member',
      builderId: OTHER_BUILDER_ID,
      status: 'pending',
      expiresAt: new Date('2026-11-01T00:00:00Z'),
    });
    expect(await store.hasPendingInvitation(OTHER_BUILDER_ID, now)).toBe(false);
    await testDb.db.insert(invitations).values({
      id: randomUUID(),
      email: 'new@other.example',
      role: 'builder_member',
      builderId: OTHER_BUILDER_ID,
      status: 'pending',
      expiresAt: new Date('2026-11-20T00:00:00Z'),
    });
    expect(await store.hasPendingInvitation(OTHER_BUILDER_ID, now)).toBe(true);

    expect(await store.hasEmbedSignal(BUILDER_ID, 'agree-co')).toBe(false);
    await testDb.db.insert(analyticsEvents).values({
      id: randomUUID(),
      event: 'embed_loaded',
      route: '/embed',
      ts: now,
      consentTs: now,
      tenantKey: 'other-co',
    });
    expect(await store.hasEmbedSignal(OTHER_BUILDER_ID, 'other-co')).toBe(true);

    const estimateId = randomUUID();
    await testDb.db.insert(estimates).values({
      id: estimateId,
      projectType: 'new_build',
      addressKey: 'agree-st',
      inputs: {},
      figures: {},
      rows: [],
      costDataVersion: 'v0.2.0',
    });
    await testDb.db.insert(leads).values({
      id: randomUUID(),
      estimateId,
      addressKey: 'agree-st',
      email: 'home@example.com',
      name: 'Homeowner',
      timeline: 'exploring',
      consentTs: now,
      source: 'embed',
      builderId: BUILDER_ID,
    });
    expect(await store.hasEmbedSignal(BUILDER_ID, 'agree-co')).toBe(true);
  });
});
