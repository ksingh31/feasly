/**
 * Platform agreement service (#722) — db faked at the store interface.
 *
 * - status reflects the CURRENT version only; the text ships with it
 * - only a builder org admin (acting as themselves) may accept; members,
 *   view-as sessions and staff without an admin membership get 403
 *   AGREEMENT_ADMIN_REQUIRED
 * - a stale version is 409 AGREEMENT_VERSION_MISMATCH
 * - acceptance records version, time, user, IP and user agent; append-only
 *   (re-accepting the same version appends nothing)
 * - the gate throws 409 AGREEMENT_REQUIRED without a current acceptance
 * - bumping the version keeps old rows but forces re-acceptance
 */
import { describe, expect, it } from 'vitest';
import {
  createBuilderAgreementService,
  type BuilderAgreementService,
} from '../src/services/builder-agreement.service';
import type {
  AgreementAcceptanceRecord,
  BuilderAgreementStore,
  NewAgreementAcceptance,
} from '../src/services/builder-agreement.store';
import type { AuthContext } from '../src/services/auth-context.service';
import { LEGAL_REVIEW_PENDING } from '../src/lib/legal-copy';

const BUILDER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'elite-craft';
const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const V1 = '2026-11-draft-1';
const V2 = '2027-01-v2';
const NOW = new Date('2026-11-15T18:00:00.000Z');

function memoryStore(): BuilderAgreementStore & {
  rows: NewAgreementAcceptance[];
} {
  const rows: NewAgreementAcceptance[] = [];
  const toRecord = (r: NewAgreementAcceptance): AgreementAcceptanceRecord => ({
    id: r.id,
    builderId: r.builderId,
    version: r.version,
    acceptedAt: r.acceptedAt,
    acceptedByUserId: r.acceptedByUserId,
    acceptedByEmail: r.acceptedByEmail,
    acceptedByName: 'Org Admin',
  });
  return {
    rows,
    async insert(row) {
      rows.push(row);
    },
    async findLatest(builderId, version) {
      const hits = rows
        .filter(
          (r) =>
            r.builderId === builderId &&
            (version === undefined || r.version === version),
        )
        .sort((a, b) => b.acceptedAt.getTime() - a.acceptedAt.getTime());
      return hits[0] ? toRecord(hits[0]) : null;
    },
    async hasAcceptanceForTenant(tenantKey, version) {
      return (
        tenantKey === TENANT &&
        rows.some((r) => r.builderId === BUILDER_ID && r.version === version)
      );
    },
  };
}

function ctx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: ADMIN_ID,
    email: 'admin@builder.example',
    name: 'Org Admin',
    staffRole: null,
    permissions: ['builder:leads:read', 'builder:billing'],
    builderId: BUILDER_ID,
    builderName: 'Elite Craft',
    memberships: [
      { builderId: BUILDER_ID, role: 'builder_admin', createdAt: NOW },
    ],
    viewAs: null,
    realUser: null,
    ...overrides,
  } as AuthContext;
}

const MEMBER = ctx({
  userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  memberships: [
    { builderId: BUILDER_ID, role: 'builder_member', createdAt: NOW },
  ],
});

function make(
  version = V1,
  store = memoryStore(),
): { service: BuilderAgreementService; store: ReturnType<typeof memoryStore> } {
  let n = 0;
  const service = createBuilderAgreementService({
    store,
    currentVersion: version,
    clock: () => NOW,
    uuid: () => `acc-${++n}`,
  });
  return { service, store };
}

const ACCEPT = { version: V1, ip: '203.0.113.7', userAgent: 'Mozilla/5.0 test' };

describe('builder agreement service (#722)', () => {
  it('status before acceptance: not current, with the versioned draft text', async () => {
    const { service } = make();
    const status = await service.getStatus(ctx(), BUILDER_ID);
    expect(status).toMatchObject({
      version: V1,
      current: false,
      acceptedAt: null,
      acceptedBy: null,
      canAccept: true,
    });
    expect(status.document.version).toBe(V1);
    expect(status.document.status).toBe(LEGAL_REVIEW_PENDING);
    expect(status.document.sections.length).toBeGreaterThan(0);
  });

  it('members may read but not accept (canAccept false, 403 AGREEMENT_ADMIN_REQUIRED)', async () => {
    const { service, store } = make();
    expect((await service.getStatus(MEMBER, BUILDER_ID)).canAccept).toBe(false);
    await expect(service.accept(MEMBER, BUILDER_ID, ACCEPT)).rejects.toMatchObject({
      status: 403,
      code: 'AGREEMENT_ADMIN_REQUIRED',
    });
    expect(store.rows).toHaveLength(0);
  });

  it('view-as and staff without an admin membership cannot accept', async () => {
    const { service } = make();
    const viewAs = ctx({
      viewAs: { userId: MEMBER.userId ?? '' } as AuthContext['viewAs'],
      realUser: { userId: ADMIN_ID, email: 'admin@builder.example', name: 'Org Admin' },
    });
    const staff = ctx({ staffRole: 'admin', memberships: [] });
    const otherOrgAdmin = ctx({
      memberships: [
        { builderId: 'other-builder', role: 'builder_admin', createdAt: NOW },
      ],
    });
    for (const c of [viewAs, staff, otherOrgAdmin]) {
      await expect(service.accept(c, BUILDER_ID, ACCEPT)).rejects.toMatchObject({
        status: 403,
        code: 'AGREEMENT_ADMIN_REQUIRED',
      });
    }
  });

  it('admin acceptance records version, time, user, IP and user agent', async () => {
    const { service, store } = make();
    const status = await service.accept(ctx(), BUILDER_ID, ACCEPT);
    expect(store.rows).toEqual([
      {
        id: 'acc-1',
        builderId: BUILDER_ID,
        version: V1,
        acceptedAt: NOW,
        acceptedByUserId: ADMIN_ID,
        acceptedByEmail: 'admin@builder.example',
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 test',
      },
    ]);
    expect(status).toMatchObject({
      version: V1,
      current: true,
      acceptedAt: NOW.toISOString(),
      acceptedBy: {
        userId: ADMIN_ID,
        name: 'Org Admin',
        email: 'admin@builder.example',
      },
    });
  });

  it('re-accepting the same version appends nothing (append-only, idempotent)', async () => {
    const { service, store } = make();
    await service.accept(ctx(), BUILDER_ID, ACCEPT);
    await service.accept(ctx(), BUILDER_ID, ACCEPT);
    expect(store.rows).toHaveLength(1);
  });

  it('truncates an oversized user agent', async () => {
    const { service, store } = make();
    await service.accept(ctx(), BUILDER_ID, { ...ACCEPT, userAgent: 'x'.repeat(5000) });
    expect(store.rows[0]?.userAgent).toHaveLength(512);
  });

  it('a stale version is 409 AGREEMENT_VERSION_MISMATCH and records nothing', async () => {
    const { service, store } = make(V2);
    await expect(service.accept(ctx(), BUILDER_ID, ACCEPT)).rejects.toMatchObject({
      status: 409,
      code: 'AGREEMENT_VERSION_MISMATCH',
    });
    expect(store.rows).toHaveLength(0);
  });

  it('gate: 409 AGREEMENT_REQUIRED without a current acceptance, passes after', async () => {
    const { service } = make();
    await expect(service.requireCurrentForTenant(TENANT)).rejects.toMatchObject({
      status: 409,
      code: 'AGREEMENT_REQUIRED',
    });
    await service.accept(ctx(), BUILDER_ID, ACCEPT);
    await expect(service.requireCurrentForTenant(TENANT)).resolves.toBeUndefined();
    expect(await service.isCurrentForTenant(TENANT)).toBe(true);
  });

  it('version bump: old acceptance kept but no longer current; gate blocks until re-accepted', async () => {
    const store = memoryStore();
    await make(V1, store).service.accept(ctx(), BUILDER_ID, ACCEPT);

    const { service } = make(V2, store);
    const status = await service.getStatus(ctx(), BUILDER_ID);
    expect(status).toMatchObject({ version: V2, current: false, acceptedAt: null });
    await expect(service.requireCurrentForTenant(TENANT)).rejects.toMatchObject({
      status: 409,
      code: 'AGREEMENT_REQUIRED',
    });
    expect(await service.getAdminSummary(BUILDER_ID)).toMatchObject({
      currentVersion: V2,
      current: false,
      acceptedVersion: V1,
    });

    await service.accept(ctx(), BUILDER_ID, { ...ACCEPT, version: V2 });
    expect(store.rows.map((r) => r.version)).toEqual([V1, V2]);
    expect(await service.isCurrentForTenant(TENANT)).toBe(true);
  });

  it('admin summary: never accepted → nulls', async () => {
    const { service } = make();
    expect(await service.getAdminSummary(BUILDER_ID)).toEqual({
      currentVersion: V1,
      current: false,
      acceptedVersion: null,
      acceptedAt: null,
      acceptedBy: null,
    });
  });
});
