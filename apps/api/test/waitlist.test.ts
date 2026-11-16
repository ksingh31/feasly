/**
 * #520 — waitlist signup endpoint (POST /api/v1/waitlist).
 *
 * Service + route against a fake store, then the real Drizzle store
 * against the migrated PGlite database (AC1: waitlist rows stored).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import { WaitlistResponseSchema } from '../src/openapi/schemas';
import { createWaitlistRoute } from '../src/routes/waitlist.route';
import { createWaitlistService } from '../src/services/waitlist.service';
import {
  createDrizzleWaitlistStore,
  type NewWaitlistSignup,
  type WaitlistStore,
} from '../src/services/waitlist.store';
import { createTestDb, type TestDb } from './pglite-db';

/** Injected via deps (config.waitlist.consentVersion in prod, #740). */
const CONSENT_VERSION = 'waitlist-test-v1';

function fakeStore(): { store: WaitlistStore; inserted: NewWaitlistSignup[] } {
  const inserted: NewWaitlistSignup[] = [];
  return {
    inserted,
    store: {
      insertIfAbsent: async (signup) => {
        inserted.push(signup);
      },
      find: async () => null,
      listByEmail: async () => [],
      deleteByEmail: async () => 0,
    },
  };
}

describe('waitlist service', () => {
  it('stores a normalized signup and returns { ok, topic }', async () => {
    const { store, inserted } = fakeStore();
    const service = createWaitlistService({ waitlist: store, consentVersion: CONSENT_VERSION });
    const res = await service.join({ email: '  Jo@Example.COM ', topic: 'renovation', consent: true });
    expect(res).toEqual({ ok: true, topic: 'renovation' });
    expect(WaitlistResponseSchema.parse(res)).toEqual(res);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.email).toBe('jo@example.com');
    expect(inserted[0]?.topic).toBe('renovation');
    expect(inserted[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted[0]?.consentVersion).toBe(CONSENT_VERSION);
  });

  it.each([
    [{ email: 'not-an-email', topic: 'toronto', consent: true }],
    [{ email: 'a@example.com', topic: 'edmonton', consent: true }],
    [{ email: 'a@example.com', consent: true }],
    [{ email: 'a@example.com', topic: 'vancouver', consent: true, extra: true }],
    // CASL (owner decision 2026-11-15): no consent → rejected, nothing stored.
    [{ email: 'a@example.com', topic: 'vancouver' }],
    [{ email: 'a@example.com', topic: 'vancouver', consent: false }],
    [{ email: 'a@example.com', topic: 'vancouver', consent: 'true' }],
    [null],
    // #689: building-form topic needs a form; other topics refuse form fields.
    [{ email: 'a@example.com', topic: 'building-form', consent: true }],
    [{ email: 'a@example.com', topic: 'building-form', consent: true, buildingForm: 'castle' }],
    [{ email: 'a@example.com', topic: 'renovation', consent: true, buildingForm: 'duplex' }],
    [{ email: 'a@example.com', topic: 'toronto', consent: true, district: 'R-C2' }],
    [{ email: 'a@example.com', topic: 'renovation', consent: true, community: 'Altadore' }],
    [{ email: 'a@example.com', topic: 'building-form', consent: true, buildingForm: 'duplex', district: 'x'.repeat(41) }],
  ])('rejects an invalid body with 400 VALIDATION_FAILED (%j)', async (body) => {
    const { store, inserted } = fakeStore();
    const service = createWaitlistService({ waitlist: store, consentVersion: CONSENT_VERSION });
    const err = await service.join(body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).code).toBe(ErrorCodes.VALIDATION_FAILED);
    expect(inserted).toHaveLength(0);
  });

  it('#689: a building-form signup records the form, district and community (AC5)', async () => {
    const { store, inserted } = fakeStore();
    const service = createWaitlistService({ waitlist: store, consentVersion: CONSENT_VERSION });
    const res = await service.join({
      email: 'f@example.com',
      topic: 'building-form',
      consent: true,
      buildingForm: 'semi-detached',
      district: ' R-C2 ',
      community: 'Altadore',
    });
    expect(res).toEqual({ ok: true, topic: 'building-form' });
    expect(inserted[0]).toMatchObject({
      topic: 'building-form',
      buildingForm: 'semi-detached',
      district: 'R-C2',
      community: 'Altadore',
    });
  });

  it('#689: renovation signups store null form fields', async () => {
    const { store, inserted } = fakeStore();
    const service = createWaitlistService({ waitlist: store, consentVersion: CONSENT_VERSION });
    await service.join({ email: 'r@example.com', topic: 'renovation', consent: true });
    expect(inserted[0]).toMatchObject({ buildingForm: null, district: null, community: null });
  });

  it('route delegates to the service', async () => {
    const { store, inserted } = fakeStore();
    const route = createWaitlistRoute({
      waitlist: createWaitlistService({ waitlist: store, consentVersion: CONSENT_VERSION }),
    });
    await expect(route.handle({ email: 'v@example.com', topic: 'vancouver', consent: true })).resolves.toEqual({
      ok: true,
      topic: 'vancouver',
    });
    expect(inserted).toHaveLength(1);
  });
});

describe('waitlist store (PGlite, real migrations)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('stores one row per (email, topic); repeats are silent no-ops', async () => {
    const store = createDrizzleWaitlistStore({ db: testDb.db });
    const service = createWaitlistService({ waitlist: store, consentVersion: CONSENT_VERSION });

    await service.join({ email: 'Repeat@Example.com', topic: 'renovation', consent: true });
    // Same answer the second time — membership is never revealed.
    await expect(
      service.join({ email: 'repeat@example.com', topic: 'renovation', consent: true }),
    ).resolves.toEqual({ ok: true, topic: 'renovation' });
    await service.join({ email: 'repeat@example.com', topic: 'toronto', consent: true });

    const rows = await testDb.rows<{ email: string; topic: string }>(
      `select email, topic from waitlist_signups order by topic`,
    );
    expect(rows).toEqual([
      { email: 'repeat@example.com', topic: 'renovation' },
      { email: 'repeat@example.com', topic: 'toronto' },
    ]);
    const found = await store.find('repeat@example.com', 'toronto');
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.consentTs).toBeInstanceOf(Date);
    expect(found?.consentVersion).toBe(CONSENT_VERSION);
    await expect(store.find('nobody@example.com', 'toronto')).resolves.toBeNull();
  });

  it('#689: one row per (email, topic, form); a repeat form is a no-op; NULL forms still collide', async () => {
    const store = createDrizzleWaitlistStore({ db: testDb.db });
    const service = createWaitlistService({ waitlist: store, consentVersion: CONSENT_VERSION });
    const form = (buildingForm: string) =>
      service.join({
        email: 'forms@example.com',
        topic: 'building-form',
        consent: true,
        buildingForm,
        district: 'R-CG',
        community: 'Killarney/Glengarry',
      });
    await form('semi-detached');
    await form('rowhouse');
    await form('semi-detached');
    await service.join({ email: 'forms@example.com', topic: 'renovation', consent: true });
    await service.join({ email: 'forms@example.com', topic: 'renovation', consent: true });

    const rows = await testDb.rows<{ topic: string; building_form: string | null; district: string | null; community: string | null }>(
      `select topic, building_form, district, community from waitlist_signups
        where email = 'forms@example.com' order by topic, building_form`,
    );
    expect(rows).toEqual([
      { topic: 'building-form', building_form: 'rowhouse', district: 'R-CG', community: 'Killarney/Glengarry' },
      { topic: 'building-form', building_form: 'semi-detached', district: 'R-CG', community: 'Killarney/Glengarry' },
      { topic: 'renovation', building_form: null, district: null, community: null },
    ]);
    const found = await store.find('forms@example.com', 'building-form', 'rowhouse');
    expect(found?.district).toBe('R-CG');
    expect((await store.find('forms@example.com', 'renovation'))?.buildingForm).toBeNull();
    // Privacy export/erasure cover the new rows (AC5).
    expect(await store.listByEmail('forms@example.com')).toHaveLength(3);
    await expect(store.deleteByEmail('forms@example.com')).resolves.toBe(3);
  });

  it('lists and deletes every signup for an email (privacy export/erasure)', async () => {
    const store = createDrizzleWaitlistStore({ db: testDb.db });
    const service = createWaitlistService({ waitlist: store, consentVersion: CONSENT_VERSION });
    await service.join({ email: 'erase-me@example.com', topic: 'renovation', consent: true });
    await service.join({ email: 'erase-me@example.com', topic: 'vancouver', consent: true });
    await service.join({ email: 'keep-me@example.com', topic: 'vancouver', consent: true });

    const listed = await store.listByEmail('erase-me@example.com');
    expect(listed.map((r) => r.topic).sort()).toEqual(['renovation', 'vancouver']);

    await expect(store.deleteByEmail('erase-me@example.com')).resolves.toBe(2);
    await expect(store.listByEmail('erase-me@example.com')).resolves.toEqual([]);
    await expect(store.listByEmail('keep-me@example.com')).resolves.toHaveLength(1);
    await expect(store.deleteByEmail('erase-me@example.com')).resolves.toBe(0);
  });
});
