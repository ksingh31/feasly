/**
 * Migration 0036 + Drizzle user-store tests (auth/01 — Entra pivot).
 *
 * Runs the real migration SQL against PGlite, then asserts the schema
 * shape (tables, columns, indexes, FKs, cascade rules, unique constraints,
 * Karan's protected seed) and exercises the Drizzle store implementations
 * end to end — no fakes below the service layer here.
 *
 * Entra owns the credential: there is no password_hash column, no
 * token_hash column, and no password anywhere in this file.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createDrizzleUserStore,
  createDrizzleInvitationStore,
  createDrizzleMembershipStore,
} from '../src/services/user.store';
import { users, builders, builderMemberships } from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

const KARAN_EMAIL = 'karanbirsingh667@gmail.com';

describe('migration 0036 — auth user model (Entra)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  it('creates the users, builder_memberships, and invitations tables', async () => {
    const rows = await testDb.rows<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('users', 'builder_memberships', 'invitations')`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      'builder_memberships',
      'invitations',
      'users',
    ]);
  });

  it('gives users the Entra columns — no password_hash anywhere', async () => {
    const rows = await testDb.rows<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select column_name, is_nullable, column_default from information_schema.columns where table_name = 'users'`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r]));
    expect(byName.get('email')?.is_nullable).toBe('NO');
    expect(byName.get('entra_object_id')?.is_nullable).toBe('YES');
    expect(byName.get('staff_role')?.is_nullable).toBe('YES');
    expect(byName.get('is_protected')?.is_nullable).toBe('NO');
    expect(byName.get('status')?.column_default).toContain('invited');
    expect(byName.has('password_hash')).toBe(false);
    // Unique email AND unique entra_object_id.
    const uniq = await testDb.rows<{ conname: string }>(
      `select conname from pg_constraint where conrelid = 'users'::regclass and contype = 'u'`,
    );
    expect(uniq.length).toBeGreaterThanOrEqual(2);
  });

  it('gives invitations the Entra shape — no token_hash anywhere', async () => {
    const rows = await testDb.rows<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'invitations'`,
    );
    const names = rows.map((r) => r.column_name);
    expect(names).toContain('role');
    expect(names).toContain('builder_id');
    expect(names).toContain('entra_user_id');
    expect(names).toContain('status');
    expect(names).toContain('expires_at');
    expect(names).not.toContain('token_hash');
    expect(names).not.toContain('staff_role');
    expect(names).not.toContain('builder_role');
  });

  it('creates the lookup indexes', async () => {
    const rows = await testDb.rows<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename in ('users', 'builder_memberships', 'invitations')`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('users_email_idx');
    expect(names).toContain('builder_memberships_user_builder_idx');
    expect(names).toContain('builder_memberships_builder_idx');
    expect(names).toContain('invitations_email_idx');
    expect(names).toContain('invitations_entra_user_id_idx');
  });

  it('wires the foreign keys with cascade deletes', async () => {
    const rows = await testDb.rows<{ conname: string; delete_rule: string }>(
      `select c.conname, pg_get_constraintdef(c.oid) as delete_rule
       from pg_constraint c join pg_class t on t.oid = c.conrelid
       where t.relname in ('builder_memberships', 'invitations') and c.contype = 'f'`,
    );
    const defs = rows.map((r) => r.delete_rule).join('\n');
    expect(defs).toContain('ON DELETE CASCADE');
    expect(defs).toContain('ON DELETE SET NULL'); // invitations.invited_by
  });

  it('adds nullable user_id to both session tables', async () => {
    for (const table of ['admin_sessions', 'builder_sessions']) {
      const rows = await testDb.rows<{
        is_nullable: string;
      }>(
        `select is_nullable from information_schema.columns where table_name = '${table}' and column_name = 'user_id'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.is_nullable).toBe('YES');
    }
  });

  it('seeds Karan as the protected super_admin with no Entra id yet', async () => {
    const rows = await testDb.rows<{
      id: string;
      status: string;
      staff_role: string;
      is_protected: boolean;
      entra_object_id: string | null;
    }>(
      `select id, status, staff_role, is_protected, entra_object_id from users where email = '${KARAN_EMAIL}'`,
    );
    expect(rows).toHaveLength(1);
    const seed = rows[0]!;
    expect(seed.id).toBe('805793cc-5aca-46f4-9498-996c784aee5a');
    expect(seed.status).toBe('invited');
    expect(seed.staff_role).toBe('super_admin');
    expect(seed.is_protected).toBe(true);
    // Linked during the Azure tenant setup — NULL until then.
    expect(seed.entra_object_id).toBeNull();
  });
});

describe('drizzle user stores (Entra)', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.close();
  });

  const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const BUILDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  beforeAll(async () => {
    await testDb.db.insert(builders).values({
      id: BUILDER_ID,
      tenantKey: 'test-builder',
      businessName: 'Test Builder Inc',
      displayName: 'Test Builder',
    });
  });

  it('user store round-trips insert → findByEmail → updateUser', async () => {
    const store = createDrizzleUserStore({ db: testDb.db });
    const created = await store.insert({
      id: USER_ID,
      email: 'ada@example.com',
      name: 'Ada',
      status: 'invited',
      staffRole: 'admin',
      entraObjectId: null,
      isProtected: false,
    });
    expect(created.entraObjectId).toBeNull();

    const found = await store.findByEmail('ada@example.com');
    expect(found?.id).toBe(USER_ID);
    expect(await store.findByEmail('missing@example.com')).toBeNull();

    // #71 links the Entra id on first sign-in.
    const linked = await store.updateUser(
      USER_ID,
      { status: 'active', entraObjectId: 'entra-ada' },
      new Date(),
    );
    expect(linked.status).toBe('active');
    expect(linked.entraObjectId).toBe('entra-ada');
    expect((await store.findById(USER_ID))?.entraObjectId).toBe('entra-ada');
  });

  it('rejects a duplicate email and a duplicate Entra id (nulls allowed)', async () => {
    const store = createDrizzleUserStore({ db: testDb.db });
    await expect(
      store.insert({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        email: 'ada@example.com',
        name: 'Ada Clone',
        status: 'invited',
        staffRole: null,
        entraObjectId: null,
        isProtected: false,
      }),
    ).rejects.toThrow();
    // Multiple NULL entra ids are fine (unique indexes ignore NULLs).
    await store.insert({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      email: 'nulls@example.com',
      name: 'Nulls',
      status: 'invited',
      staffRole: null,
      entraObjectId: null,
      isProtected: false,
    });
    // A second row with the same non-null Entra id is not.
    await expect(
      store.updateUser(
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        { entraObjectId: 'entra-ada' },
        new Date(),
      ),
    ).rejects.toThrow();
  });

  it('invitation store tracks pending → accepted/revoked with the new shape', async () => {
    const store = createDrizzleInvitationStore({ db: testDb.db });
    const email = 'invite@example.com';
    const first = await store.insert({
      id: '11111111-1111-4111-8111-111111111111',
      email,
      invitedBy: null,
      role: 'builder_member',
      builderId: BUILDER_ID,
      entraUserId: 'entra-invite',
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await store.insert({
      id: '22222222-2222-4222-8222-222222222222',
      email,
      invitedBy: null,
      role: 'viewer',
      builderId: null,
      entraUserId: 'entra-invite',
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600_000),
    });

    expect(await store.findPendingByEmail(email)).toHaveLength(2);
    const latest = await store.findLatestByEmail(email);
    expect(latest?.role).toBe('viewer');

    await store.markStatus(first.id, 'accepted');
    expect(await store.findPendingByEmail(email)).toHaveLength(1);

    const revoked = await store.revokePendingByEmail(email);
    expect(revoked).toBe(1);
    expect(await store.findPendingByEmail(email)).toHaveLength(0);
    expect(await store.findLatestByEmail(email)).not.toBeNull();
  });

  it('membership store is idempotent and cascades on user delete', async () => {
    const store = createDrizzleMembershipStore({ db: testDb.db });
    const first = await store.add(USER_ID, BUILDER_ID, 'builder_admin');
    const second = await store.add(USER_ID, BUILDER_ID, 'builder_member');
    // Idempotent: same membership, original role kept.
    expect(second.role).toBe('builder_admin');
    expect(first.builderId).toBe(BUILDER_ID);

    expect(await store.listByUserId(USER_ID)).toHaveLength(1);

    // Deleting the user cascades the membership away.
    await testDb.db.delete(users).where(sql`${users.id} = ${USER_ID}`);
    expect(await store.listByUserId(USER_ID)).toHaveLength(0);
  });

  it('rejects a second membership for the same user+builder pair', async () => {
    const userStore = createDrizzleUserStore({ db: testDb.db });
    const memberships = createDrizzleMembershipStore({ db: testDb.db });
    // add() is idempotent via onConflictDoNothing — the raw constraint is
    // what the migration guarantees; verify it directly.
    const uid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await userStore.insert({
      id: uid,
      email: 'pair@example.com',
      name: 'Pair',
      status: 'active',
      staffRole: null,
      entraObjectId: 'entra-pair',
      isProtected: false,
    });
    await memberships.add(uid, BUILDER_ID, 'builder_member');
    await expect(
      testDb.db.insert(builderMemberships).values({
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        userId: uid,
        builderId: BUILDER_ID,
        role: 'builder_member',
      }),
    ).rejects.toThrow();
  });
});
