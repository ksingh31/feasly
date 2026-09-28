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
