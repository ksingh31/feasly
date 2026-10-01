/**
 * Unit tests for BuilderService.createBuilder duplicate handling.
 *
 * The pre-check catches the common duplicate-tenant-key case, but a
 * concurrent check-then-insert race can still hit Postgres 23505 at
 * insert time. That must map to the same 409 (not a 500), while
 * non-unique insert errors still propagate and no audit row is written
 * for a failed creation.
 *
 * Fakes the drizzle `db` chain; no real database.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBuilderService } from '../src/services/builder.service';
import type { AdminAuditStore } from '../src/services/admin-audit.store';
import type { AppDb } from '../src/db/client';

const NOW = new Date('2026-09-27T12:00:00Z');

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    tenantKey: 'elite-craft',
    businessName: 'Elite Craft Builders Ltd.',
    displayName: 'Elite Craft Builders',
    email: null,
    phone: null,
    logoUrl: null,
    accentColor: null,
    allowedOrigins: [],
    plan: null,
    status: 'active',
    settings: {},
    commissionRatePercent: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Drizzle wraps the pg error: Error('Failed query: ...', { cause }). */
function wrappedUniqueViolation(): Error {
  const pgError = Object.assign(new Error('duplicate key value'), {
    code: '23505',
  });
  return new Error('Failed query: insert into "builders"', { cause: pgError });
}

function makeDb(opts: {
  readonly findFirst?: unknown;
  readonly insertBehavior?: 'ok' | 'unique-violation' | 'other-error';
}) {
  const insertCalls: unknown[] = [];
  const db = {
    query: {
      builders: {
        findFirst: vi.fn(async () => opts.findFirst),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        insertCalls.push(values);
        return {
          returning: vi.fn(async () => {
            if (opts.insertBehavior === 'unique-violation') {
              throw wrappedUniqueViolation();
            }
            if (opts.insertBehavior === 'other-error') {
              throw new Error('connection reset');
            }
            return [makeRow({ tenantKey: (values as { tenantKey: string }).tenantKey })];
          }),
        };
      }),
    })),
  };
  return { db: db as unknown as AppDb, insertCalls };
}

function makeDeps(db: AppDb) {
  const audit = { log: vi.fn(async () => {}) } as unknown as AdminAuditStore;
  return { service: createBuilderService({ db, audit }), audit };
}

const INPUT = {
  tenantKey: 'new-builder',
  businessName: 'New Builder Ltd.',
  displayName: 'New Builder',
};

describe('BuilderService.createBuilder duplicate handling', () => {
  it('pre-check duplicate returns 409 without inserting', async () => {
    const { db, insertCalls } = makeDb({ findFirst: makeRow() });
    const { service, audit } = makeDeps(db);

    await expect(service.createBuilder(INPUT, 'admin@example.com')).rejects.toMatchObject({
      status: 409,
    });
    expect(insertCalls).toHaveLength(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('insert-time unique violation (lost race) maps to 409', async () => {
    const { db } = makeDb({ findFirst: undefined, insertBehavior: 'unique-violation' });
    const { service, audit } = makeDeps(db);

    await expect(service.createBuilder(INPUT, 'admin@example.com')).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
    });
    // No audit row for a creation that never happened.
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('non-unique insert errors still propagate', async () => {
    const { db } = makeDb({ findFirst: undefined, insertBehavior: 'other-error' });
    const { service, audit } = makeDeps(db);

    await expect(service.createBuilder(INPUT, 'admin@example.com')).rejects.toThrow(
      'connection reset',
    );
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('successful create returns the builder and audit-logs', async () => {
    const { db } = makeDb({ findFirst: undefined, insertBehavior: 'ok' });
    const { service, audit } = makeDeps(db);

    const builder = await service.createBuilder(INPUT, 'admin@example.com');
    expect(builder.tenantKey).toBe('new-builder');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_builder_created' }),
    );
  });
});

describe('BuilderService commission rate (billing/08)', () => {
  it('defaults to 1% when omitted on create', async () => {
    const { db, insertCalls } = makeDb({ findFirst: undefined, insertBehavior: 'ok' });
    const { service } = makeDeps(db);

    const builder = await service.createBuilder(INPUT, 'admin@example.com');
    expect(builder.commissionRatePercent).toBe(1);
    expect(insertCalls[0]).toMatchObject({ commissionRatePercent: 1 });
  });

  it('stores a custom rate on create', async () => {
    const { db, insertCalls } = makeDb({ findFirst: undefined, insertBehavior: 'ok' });
    const { service } = makeDeps(db);

    const builder = await service.createBuilder(
      { ...INPUT, commissionRatePercent: 1.5 },
      'admin@example.com',
    );
    expect(insertCalls[0]).toMatchObject({ commissionRatePercent: 1.5 });
    // The returned row echoes the DB default in this fake; the insert
    // payload is the assertion that matters.
    expect(builder.commissionRatePercent).toBeDefined();
  });

  it('accepts 0% — a legitimate negotiated outcome', async () => {
    const { db, insertCalls } = makeDb({ findFirst: undefined, insertBehavior: 'ok' });
    const { service } = makeDeps(db);

    await service.createBuilder(
      { ...INPUT, commissionRatePercent: 0 },
      'admin@example.com',
    );
    expect(insertCalls[0]).toMatchObject({ commissionRatePercent: 0 });
  });

  it('rejects rates above 10% with INVALID_RATE (400)', async () => {
    const { db, insertCalls } = makeDb({ findFirst: undefined, insertBehavior: 'ok' });
    const { service, audit } = makeDeps(db);

    await expect(
      service.createBuilder({ ...INPUT, commissionRatePercent: 10.01 }, 'admin@example.com'),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_RATE' });
    expect(insertCalls).toHaveLength(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('rejects negative rates with INVALID_RATE (400)', async () => {
    const { db } = makeDb({ findFirst: undefined, insertBehavior: 'ok' });
    const { service } = makeDeps(db);

    await expect(
      service.createBuilder({ ...INPUT, commissionRatePercent: -1 }, 'admin@example.com'),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_RATE' });
  });

  it('rejects non-numeric rates with VALIDATION_FAILED (400)', async () => {
    const { db } = makeDb({ findFirst: undefined, insertBehavior: 'ok' });
    const { service } = makeDeps(db);

    await expect(
      service.createBuilder(
        { ...INPUT, commissionRatePercent: '1.5' as unknown as number },
        'admin@example.com',
      ),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('update audits old->new when the rate changes', async () => {
    const current = makeRow({ commissionRatePercent: 1 });
    const updateCalls: unknown[] = [];
    const db = {
      query: {
        builders: { findFirst: vi.fn(async () => current) },
      },
      update: vi.fn(() => ({
        set: vi.fn((patch: unknown) => {
          updateCalls.push(patch);
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [makeRow({ commissionRatePercent: 2 })]),
            })),
          };
        }),
      })),
    } as unknown as AppDb;
    const { service, audit } = makeDeps(db);

    const builder = await service.updateBuilder(current.id, { commissionRatePercent: 2 }, 'admin@example.com');
    expect(updateCalls[0]).toMatchObject({ commissionRatePercent: 2 });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin_builder_commission_rate_changed',
        detail: expect.stringContaining('from=1 to=2'),
      }),
    );
    expect(builder.commissionRatePercent).toBe(2);
  });

  it('update does not audit when the rate is unchanged', async () => {
    const current = makeRow({ commissionRatePercent: 1 });
    const db = {
      query: {
        builders: { findFirst: vi.fn(async () => current) },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => [makeRow({ commissionRatePercent: 1 })]),
          })),
        })),
      })),
    } as unknown as AppDb;
    const { service, audit } = makeDeps(db);

    await service.updateBuilder(current.id, { commissionRatePercent: 1 }, 'admin@example.com');
    const rateAudits = (audit.log as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { action: string }).action === 'admin_builder_commission_rate_changed',
    );
    expect(rateAudits).toHaveLength(0);
  });
});

describe('BuilderService.updateBuilder defaultPaymentMethod', () => {
  function makeUpdateDb(current: ReturnType<typeof makeRow>, returning: ReturnType<typeof makeRow>) {
    const updateCalls: unknown[] = [];
    const db = {
      query: {
        builders: { findFirst: vi.fn(async () => current) },
      },
      update: vi.fn(() => ({
        set: vi.fn((patch: unknown) => {
          updateCalls.push(patch);
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [returning]),
            })),
          };
        }),
      })),
    } as unknown as AppDb;
    return { db, updateCalls };
  }

  it('merges the default method into settings and audits old->new', async () => {
    const current = makeRow({ settings: {} });
    const { db, updateCalls } = makeUpdateDb(
      current,
      makeRow({ settings: { defaultPaymentMethod: 'cheque' } }),
    );
    const { service, audit } = makeDeps(db);

    const builder = await service.updateBuilder(
      current.id,
      { defaultPaymentMethod: 'cheque' },
      'admin@example.com',
    );
    expect(updateCalls[0]).toMatchObject({
      settings: { defaultPaymentMethod: 'cheque' },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin_builder_default_payment_method_changed',
        detail: expect.stringContaining('from=card to=cheque'),
      }),
    );
    expect(builder.settings).toMatchObject({ defaultPaymentMethod: 'cheque' });
  });

  it('dedicated field wins over a stale defaultPaymentMethod in a settings patch', async () => {
    const current = makeRow({
      settings: { defaultPaymentMethod: 'cheque' },
    });
    const { db, updateCalls } = makeUpdateDb(
      current,
      makeRow({ settings: { defaultPaymentMethod: 'e_transfer' } }),
    );
    const { service } = makeDeps(db);

    await service.updateBuilder(
      current.id,
      {
        settings: { defaultPaymentMethod: 'card' },
        defaultPaymentMethod: 'e_transfer',
      },
      'admin@example.com',
    );
    expect(updateCalls[0]).toMatchObject({
      settings: { defaultPaymentMethod: 'e_transfer' },
    });
  });

  it('does not audit or patch settings when the method is unchanged', async () => {
    const current = makeRow({
      settings: { defaultPaymentMethod: 'cheque' },
    });
    const { db, updateCalls } = makeUpdateDb(current, current);
    const { service, audit } = makeDeps(db);

    await service.updateBuilder(
      current.id,
      { defaultPaymentMethod: 'cheque' },
      'admin@example.com',
    );
    const methodAudits = (audit.log as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { action: string }).action ===
        'admin_builder_default_payment_method_changed',
    );
    expect(methodAudits).toHaveLength(0);
    expect(updateCalls[0]).not.toHaveProperty('settings');
  });
});
