/**
 * Migration 0036 + Drizzle user-store tests (auth/01).
 *
 * Runs the real migration SQL against PGlite, then asserts the schema
 * shape (tables, columns, indexes, FKs, cascade rules, unique constraints,
 * Karan's protected seed) and exercises the Drizzle store implementations
 * end to end — no fakes below the service layer here.
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

describe('migration 0036 — auth user model', () => {
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

  it('gives users the auth columns with the right nullability and defaults', async () => {
    const rows = await testDb.rows<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select column_name, is_nullable, column_default from information_schema.columns where table_name = 'users'`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r]));
    expect(byName.get('email')?.is_nullable).toBe('NO');
    expect(byName.get('password_hash')?.is_nullable).toBe('YES');
    expect(byName.get('staff_role')?.is_nullable).toBe('YES');
    expect(byName.get('is_protected')?.is_nullable).toBe('NO');
    expect(byName.get('status')?.column_default).toContain('invited');
    // Unique email.
    const uniq = await testDb.rows<{ conname: string }>(
      `select conname from pg_constraint where conrelid = 'users'::regclass and contype = 'u'`,
    );
    expect(uniq.length).toBeGreaterThanOrEqual(1);
  });

  it('creates the lookup indexes and the unique membership pair', async () => {
    const rows = await testDb.rows<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename in ('users', 'builder_memberships', 'invitations')`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('users_email_idx');
    expect(names).toContain('builder_memberships_user_builder_idx');
    expect(names).toContain('builder_memberships_builder_idx');
    expect(names).toContain('invitations_token_hash_idx');
    expect(names).toContain('invitations_email_idx');
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

  it('seeds Karan as the protected super_admin (invited, no password)', async () => {
    const rows = await testDb.rows<{
      id: string;
      status: string;
      staff_role: string;
      is_protected: boolean;
      password_hash: string | null;
    }>(
      `select id, status, staff_role, is_protected, password_hash from users where email = '${KARAN_EMAIL}'`,
    );
    expect(rows).toHaveLength(1);
    const seed = rows[0]!;
    expect(seed.id).toBe('805793cc-5aca-46f4-9498-996c784aee5a');
    expect(seed.status).toBe('invited');
    expect(seed.staff_role).toBe('super_admin');
    expect(seed.is_protected).toBe(true);
    expect(seed.password_hash).toBeNull();
  });
});

describe('drizzle user stores', () => {
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

  it('user store round-trips insert → findByEmail', async () => {
    const store = createDrizzleUserStore({ db: testDb.db });
    const created = await store.insert({
      id: USER_ID,
      email: 'ada@example.com',
      name: 'Ada',
      status: 'invited',
      staffRole: 'admin',
      isProtected: false,
    });
    expect(created.passwordHash).toBeNull();
    const found = await store.findByEmail('ada@example.com');
    expect(found?.id).toBe(USER_ID);
    expect(await store.findByEmail('missing@example.com')).toBeNull();
  });

  it('rejects a duplicate email (unique identity)', async () => {
    const store = createDrizzleUserStore({ db: testDb.db });
    await expect(
      store.insert({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        email: 'ada@example.com',
        name: 'Ada Clone',
        status: 'invited',
        staffRole: null,
        isProtected: false,
      }),
    ).rejects.toThrow();
  });

  it('setPasswordHash flips invited → active but never disabled → active', async () => {
    const store = createDrizzleUserStore({ db: testDb.db });
    const flipped = await store.setPasswordHash(
      USER_ID,
      '$2b$04$dummyhashfortestingonly..................',
      new Date(),
    );
    expect(flipped.status).toBe('active');
    expect(flipped.passwordHash).toContain('$2b$04$');

    const disabledId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await store.insert({
      id: disabledId,
      email: 'disabled@example.com',
      name: 'Dis',
      status: 'disabled',
      staffRole: null,
      isProtected: false,
    });
    const stillDisabled = await store.setPasswordHash(
      disabledId,
      '$2b$04$dummyhashfortestingonly..................',
      new Date(),
    );
    expect(stillDisabled.status).toBe('disabled');
  });

  it('invitation store tracks pending excluding accepted and revoked', async () => {
    const store = createDrizzleInvitationStore({ db: testDb.db });
    const email = 'invite@example.com';
    const mk = (tokenHash: string) =>
      store.insert({
        id: tokenHash.slice(0, 8) + '-0000-4000-8000-000000000000',
        email,
        staffRole: 'viewer',
        builderId: null,
        builderRole: null,
        tokenHash,
        expiresAt: new Date(Date.now() + 3600_000),
        invitedBy: null,
      });
    const first = await mk('a'.repeat(64));
    await mk('b'.repeat(64));
    expect(await store.findPendingByEmail(email)).toHaveLength(2);
    expect(await store.findByTokenHash('a'.repeat(64))).not.toBeNull();

    await store.markAccepted(first.id, new Date());
    expect(await store.findPendingByEmail(email)).toHaveLength(1);

    const revoked = await store.revokePendingByEmail(email, new Date());
    expect(revoked).toBe(1);
    expect(await store.findPendingByEmail(email)).toHaveLength(0);
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
