/**
 * Last-admin protection — real drizzle stores on PGlite (auth/07).
 *
 * Same cases as the unit tests, but against the real SQL: the FOR UPDATE
 * guard queries, the transaction-scoped stores, and the 409 path all run
 * on actual Postgres semantics. The race test fires two simultaneous
 * demotions of the last two admins and asserts exactly one 409 — on
 * PGlite the two transactions serialize (PGlite runs each transaction
 * exclusively), so the loser's guard re-checks after the winner commits;
 * on real Postgres the FOR UPDATE row locks give the same outcome under
 * true concurrency (see the locking comment on listActiveStaffAdminIds).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { HttpError } from '../src/middleware/errors';
import { createTestDb, type TestDb } from './pglite-db';
import {
  createDrizzleUserStore,
  createDrizzleMembershipStore,
  createDrizzleInvitationStore,
} from '../src/services/user.store';
import {
  createUserService,
  type UserService,
  type UserStore,
  type MembershipStore,
} from '../src/services/user.service';
import type { EntraUserService } from '../src/services/entra-user.service';

// Seeded by migration 0035_builders_table.sql (fixed UUIDs).
const ORG_A = 'a506cc36-ffd1-42db-993c-999bfbb0f1d2'; // elite-craft-builders
const ORG_B = '6f2c90fd-2395-4f6c-8e71-3b699cf68857'; // demo

const ROLE_MESSAGE =
  "You can't change the role of the last administrator. Add another administrator first.";
const DEACTIVATE_MESSAGE =
  'Every organization needs at least one active administrator.';

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(status);
    return error as HttpError;
  }
  throw new Error(`expected an HttpError with status ${status}`);
}

describe('last-admin protection (real stores, PGlite)', () => {
  let testDb: TestDb;
  let service: UserService;
  let users: UserStore;
  let memberships: MembershipStore;

  // Fresh database per test: "last admin" assertions are global over the
  // users table, so no test may see another test's seeded admins.
  beforeEach(async () => {
    testDb = await createTestDb();
    users = createDrizzleUserStore({ db: testDb.db });
    memberships = createDrizzleMembershipStore({ db: testDb.db });
    const invitations = createDrizzleInvitationStore({ db: testDb.db });
    const entra = {
      configured: true,
      async createExternalUser() {
        return { entraObjectId: randomUUID() };
      },
      async setAccountEnabled() {},
      async deleteUser() {},
    } as unknown as EntraUserService;
    service = createUserService({
      users,
      invitations,
      memberships,
      entra,
      email: {
        async sendInvitation() {
          return { sent: true as const, provider: 'log' as const };
        },
      },
      audit: {
        async append(entry: {
          action: string;
          actorEmail: string | null;
          detail?: string;
        }) {
          return {
            id: randomUUID(),
            actorEmail: entry.actorEmail,
            action: entry.action,
            detail: entry.detail ?? null,
            createdAt: new Date('2026-09-30T00:00:00Z'),
          };
        },
        async log() {},
        async recent() {
          return [];
        },
      },
      appBaseUrl: 'https://feasly.example',
      clock: () => new Date('2026-09-30T00:00:00Z'),
      uuid: () => randomUUID(),
    });
  }, 60_000);

  afterEach(async () => {
    await testDb.close();
  });

  async function seedStaffAdmin(email: string) {
    return users.insert({
      id: randomUUID(),
      email,
      name: email,
      status: 'active',
      staffRole: 'admin',
      entraObjectId: null,
      isProtected: false,
    });
  }

  async function seedOrgAdmin(email: string, builderId: string) {
    const user = await users.insert({
      id: randomUUID(),
      email,
      name: email,
      status: 'active',
      staffRole: null,
      entraObjectId: null,
      isProtected: false,
    });
    await memberships.add(user.id, builderId, 'builder_admin');
    return user;
  }

  it('changeStaffRole: demoting the last staff admin → 409, row untouched', async () => {
    const only = await seedStaffAdmin('pg-only@example.com');
    const error = await expectHttpError(
      service.changeStaffRole(only.id, 'viewer', {
        actorStaffRole: 'super_admin',
        actorEmail: 'x@example.com',
      }),
      409,
    );
    expect(error.code).toBe('LAST_ADMIN');
    expect(error.message).toBe(ROLE_MESSAGE);
    expect((await users.findById(only.id))!.staffRole).toBe('admin');
  });

  it('changeStaffRole: demoting one of two staff admins commits', async () => {
    const first = await seedStaffAdmin('pg-first@example.com');
    await seedStaffAdmin('pg-second@example.com');
    const demoted = await service.changeStaffRole(first.id, 'viewer', {
      actorStaffRole: 'super_admin',
      actorEmail: 'x@example.com',
    });
    expect(demoted.staffRole).toBe('viewer');
    expect((await users.findById(first.id))!.staffRole).toBe('viewer');
  });

  it('disableUser: deactivating the last staff admin → 409, still active', async () => {
    const only = await seedStaffAdmin('pg-donly@example.com');
    const error = await expectHttpError(
      service.disableUser(only.id, { actorEmail: 'x@example.com' }),
      409,
    );
    expect(error.code).toBe('LAST_ADMIN');
    expect(error.message).toBe(DEACTIVATE_MESSAGE);
    expect((await users.findById(only.id))!.status).toBe('active');
  });

  it('setMemberships: demoting the sole builder_admin of an org → 409', async () => {
    const sole = await seedOrgAdmin('pg-sole@example.com', ORG_A);
    const error = await expectHttpError(
      service.setMemberships(
        sole.id,
        [{ builderId: ORG_A, role: 'builder_member' }],
        { actorEmail: 'x@example.com' },
      ),
      409,
    );
    expect(error.code).toBe('LAST_ADMIN');
    expect(error.message).toBe(ROLE_MESSAGE);
    // The membership is untouched.
    expect(await memberships.listByUserId(sole.id)).toEqual([
      expect.objectContaining({ builderId: ORG_A, role: 'builder_admin' }),
    ]);
  });

  it('race: two simultaneous demotions of the last two admins → exactly one 409', async () => {
    const a = await seedStaffAdmin('pg-race-a@example.com');
    const b = await seedStaffAdmin('pg-race-b@example.com');
    const results = await Promise.allSettled([
      service.changeStaffRole(a.id, 'viewer', {
        actorStaffRole: 'super_admin',
        actorEmail: 'x@example.com',
      }),
      service.changeStaffRole(b.id, 'viewer', {
        actorStaffRole: 'super_admin',
        actorEmail: 'x@example.com',
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(HttpError);
    expect((reason as HttpError).status).toBe(409);
    expect((reason as HttpError).code).toBe('LAST_ADMIN');
    // Exactly one of the two racers is still an admin — the platform is
    // never left without one.
    const remaining = await users.listActiveStaffAdminIds();
    const survivors = [a.id, b.id].filter((id) => remaining.includes(id));
    expect(survivors).toHaveLength(1);
    // And the winner's demotion really committed.
    const loser = [a.id, b.id].find((id) => !survivors.includes(id))!;
    expect((await users.findById(loser))!.staffRole).toBe('viewer');
  });

  it('disableUser: sole admin of org A blocked even with a co-admin in org B', async () => {
    const u1 = await seedOrgAdmin('pg-u1@example.com', ORG_A);
    await memberships.add(u1.id, ORG_B, 'builder_admin');
    await seedOrgAdmin('pg-u2@example.com', ORG_B);
    await expectHttpError(
      service.disableUser(u1.id, { actorEmail: 'x@example.com' }),
      409,
    );
    expect((await users.findById(u1.id))!.status).toBe('active');
  });
});
