/**
 * BuilderPartnersService (#888): public list = active only, in order,
 * no admin fields; admin add / deactivate / reorder with validation and
 * audit rows; in-memory cache invalidated by admin writes.
 *
 * The store is faked at its interface (in-memory rows); the SQL-level
 * active filter is covered by builder-partners.store.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBuilderPartnersService } from '../src/services/builder-partners.service';
import type {
  BuilderPartnerRow,
  BuilderPartnerStore,
} from '../src/services/builder-partners.store';
import type { AdminAuditStore } from '../src/services/admin-audit.store';

const BUILDER_ID = '123e4567-e89b-12d3-a456-426614174000';
const ADMIN = 'admin@example.com';

function row(overrides: Partial<BuilderPartnerRow> = {}): BuilderPartnerRow {
  const at = new Date('2026-11-16T00:00:00Z');
  return {
    id: overrides.id ?? `p-${Math.random().toString(16).slice(2)}`,
    builderId: null,
    name: 'Partner',
    logoUrl: null,
    websiteUrl: null,
    description: null,
    displayOrder: 0,
    active: true,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function fakeStore(initial: BuilderPartnerRow[]) {
  const rows = [...initial];
  const sorted = (list: BuilderPartnerRow[]) =>
    [...list].sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
  const store: BuilderPartnerStore = {
    listAll: vi.fn(async () => sorted(rows)),
    listActive: vi.fn(async () => sorted(rows.filter((r) => r.active))),
    get: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    maxDisplayOrder: vi.fn(async () =>
      rows.length === 0 ? -1 : Math.max(...rows.map((r) => r.displayOrder)),
    ),
    builderExists: vi.fn(async (id: string) => id === BUILDER_ID),
    insert: vi.fn(async (r) => {
      const created = row({ ...r });
      rows.push(created);
      return created;
    }),
    update: vi.fn(async (id, patch) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return null;
      rows[i] = { ...rows[i]!, ...patch, updatedAt: new Date('2026-11-17T00:00:00Z') };
      return rows[i]!;
    }),
  };
  return { store, rows };
}

function fakeAudit() {
  const log = vi.fn(async (_e: { action: string; actorEmail: string | null; detail?: string }) => {});
  return { audit: { log } as unknown as AdminAuditStore, log };
}

function make(initial: BuilderPartnerRow[], cacheTtlMs = 60_000) {
  const { store, rows } = fakeStore(initial);
  const { audit, log } = fakeAudit();
  let clock = 1_000;
  const service = createBuilderPartnersService({
    store,
    audit,
    config: { cacheTtlMs, cacheMaxAgeSeconds: 300 },
    now: () => clock,
  });
  return {
    service,
    store,
    rows,
    log,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('BuilderPartnersService — public list', () => {
  it('returns active partners only, in display order, without admin fields', async () => {
    const { service } = make([
      row({ id: 'b', name: 'Bravo', displayOrder: 2 }),
      row({ id: 'a', name: 'Alpha', displayOrder: 1, websiteUrl: 'https://a.example' }),
      row({ id: 'x', name: 'Hidden', displayOrder: 0, active: false }),
    ]);
    const list = await service.listPublic();
    expect(list.map((p) => p.name)).toEqual(['Alpha', 'Bravo']);
    expect(list[0]).toEqual({
      id: 'a',
      name: 'Alpha',
      logoUrl: null,
      websiteUrl: 'https://a.example',
      description: null,
    });
    expect(Object.keys(list[0]!)).not.toContain('builderId');
    expect(Object.keys(list[0]!)).not.toContain('active');
  });

  it('caches for the TTL, then reloads', async () => {
    const { service, store, advance } = make([row({ name: 'A' })]);
    await service.listPublic();
    await service.listPublic();
    expect(store.listActive).toHaveBeenCalledTimes(1);
    advance(60_001);
    await service.listPublic();
    expect(store.listActive).toHaveBeenCalledTimes(2);
  });

  it('cacheTtlMs 0 disables the cache', async () => {
    const { service, store } = make([row({ name: 'A' })], 0);
    await service.listPublic();
    await service.listPublic();
    expect(store.listActive).toHaveBeenCalledTimes(2);
  });

  it('a second partner turned on shows up at once (admin write invalidates the cache)', async () => {
    const { service } = make([row({ id: 'elite', name: 'Elite Craft Builders' })]);
    expect((await service.listPublic()).map((p) => p.name)).toEqual(['Elite Craft Builders']);
    await service.create({ name: 'Second Builder', websiteUrl: 'https://second.example' }, ADMIN);
    expect((await service.listPublic()).map((p) => p.name)).toEqual([
      'Elite Craft Builders',
      'Second Builder',
    ]);
  });
});

describe('BuilderPartnersService — admin add', () => {
  it('adds a partner after the current last one, active by default, audit-logged', async () => {
    const { service, log } = make([row({ displayOrder: 4 })]);
    const created = await service.create(
      {
        name: '  New Builder  ',
        websiteUrl: 'https://new.example',
        logoUrl: '',
        description: 'Infill in the inner city',
        builderId: BUILDER_ID,
      },
      ADMIN,
    );
    expect(created).toMatchObject({
      name: 'New Builder',
      websiteUrl: 'https://new.example',
      logoUrl: null,
      description: 'Infill in the inner city',
      builderId: BUILDER_ID,
      displayOrder: 5,
      active: true,
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorEmail: ADMIN,
        action: 'admin_partner_created',
        detail: expect.stringContaining(`partnerId=${created.id}`),
      }),
    );
  });

  it('first partner gets display order 0', async () => {
    const { service } = make([]);
    expect((await service.create({ name: 'Only' }, ADMIN)).displayOrder).toBe(0);
  });

  it.each([
    [{ name: '' }, 'empty name'],
    [{ name: 'x'.repeat(201) }, 'long name'],
    [{ name: 'A', websiteUrl: 'http://insecure.example' }, 'http website'],
    [{ name: 'A', websiteUrl: 'javascript:alert(1)' }, 'script URL'],
    [{ name: 'A', logoUrl: 'not a url' }, 'bad logo'],
    [{ name: 'A', description: 'd'.repeat(501) }, 'long description'],
    [{ name: 'A', displayOrder: -1 }, 'negative order'],
    [{ name: 'A', displayOrder: 1.5 }, 'fractional order'],
    [{ name: 'A', builderId: '00000000-0000-4000-8000-000000000000' }, 'unknown builder'],
  ])('rejects %o (%s) with 400 and writes nothing', async (body, _why) => {
    const { service, store, log } = make([]);
    await expect(service.create(body, ADMIN)).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(store.insert).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe('BuilderPartnersService — admin update', () => {
  it('deactivates a partner: hidden from the public list, audit-logged', async () => {
    const { service, log } = make([
      row({ id: 'a', name: 'Alpha', displayOrder: 0 }),
      row({ id: 'b', name: 'Bravo', displayOrder: 1 }),
    ]);
    await service.listPublic(); // warm the cache
    const updated = await service.update('a', { active: false }, ADMIN);
    expect(updated.active).toBe(false);
    expect((await service.listPublic()).map((p) => p.name)).toEqual(['Bravo']);
    const actions = log.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(['admin_partner_updated', 'admin_partner_deactivated']);
    expect(log.mock.calls[0]![0].detail).toBe('partnerId=a fields=active');
  });

  it('reactivating logs admin_partner_activated', async () => {
    const { service, log } = make([row({ id: 'a', active: false })]);
    await service.update('a', { active: true }, ADMIN);
    expect(log.mock.calls.map((c) => c[0].action)).toContain('admin_partner_activated');
  });

  it('reorders partners via displayOrder', async () => {
    const { service } = make([
      row({ id: 'a', name: 'Alpha', displayOrder: 0 }),
      row({ id: 'b', name: 'Bravo', displayOrder: 1 }),
    ]);
    await service.update('b', { displayOrder: 0 }, ADMIN);
    await service.update('a', { displayOrder: 1 }, ADMIN);
    expect((await service.listPublic()).map((p) => p.name)).toEqual(['Bravo', 'Alpha']);
    expect((await service.listAdmin()).map((p) => p.displayOrder)).toEqual([0, 1]);
  });

  it('explicit null clears a nullable field', async () => {
    const { service } = make([row({ id: 'a', websiteUrl: 'https://a.example' })]);
    expect((await service.update('a', { websiteUrl: null }, ADMIN)).websiteUrl).toBeNull();
  });

  it('404 for an unknown partner', async () => {
    const { service, store } = make([]);
    await expect(service.update('missing', { active: false }, ADMIN)).rejects.toMatchObject({
      status: 404,
    });
    expect(store.update).not.toHaveBeenCalled();
  });

  it('an empty patch is a no-op (no write, no audit row)', async () => {
    const { service, store, log } = make([row({ id: 'a', name: 'Alpha' })]);
    expect((await service.update('a', {}, ADMIN)).name).toBe('Alpha');
    expect(store.update).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('invalid values are 400 before any write', async () => {
    const { service, store } = make([row({ id: 'a' })]);
    await expect(service.update('a', { name: '   ' }, ADMIN)).rejects.toMatchObject({
      status: 400,
    });
    expect(store.update).not.toHaveBeenCalled();
  });
});
