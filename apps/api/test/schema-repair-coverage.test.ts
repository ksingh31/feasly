/**
 * Regression guard for the 2026-09-27 P0.
 *
 * The consumer report endpoint (GET /api/v1/reports/{token}) 500'd for
 * every property because the `report_snapshots` table (migration 0024)
 * never materialized on dev — drizzle-kit silently skipped the migration —
 * and the idempotent repair script in `tools/repair-sql.mjs` didn't cover
 * that table.
 *
 * This test asserts EVERY pgTable declared in the Drizzle schema (and every
 * one of its columns) is covered by the repair SQL, so a silently-skipped
 * migration can never again leave a table the API touches in a broken
 * state. When you add a table/column to the schema, add it here too —
 * this test will fail until you do.
 *
 * No database needed: it inspects the schema objects and the SQL text.
 */
import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
// @ts-expect-error: plain .mjs module without type declarations
import { REPAIR_SQL } from '../tools/repair-sql.mjs';
import * as schema from '../src/db/schema';

const REPAIR: string = REPAIR_SQL as string;

const tables = (Object.values(schema) as unknown[]).filter(
  (value): value is Table =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<PropertyKey, unknown>)[
      Symbol.for('drizzle:Name')
    ] === 'string',
);

describe('schema repair coverage', () => {
  it('declares at least one table', () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  it.each(
    tables.map((table) => {
      const tableName = getTableName(table);
      const dbColumns = Object.values(getTableColumns(table)).map(
        (column) => (column as { name: string }).name,
      );
      return { tableName, dbColumns };
    }),
  )(
    'repair SQL covers table "$tableName" ($dbColumns.length columns)',
    ({ tableName, dbColumns }) => {
      expect(
        REPAIR.includes(`"${tableName}"`),
        `table "${tableName}" is missing from tools/repair-sql.mjs — ` +
          `a silently-skipped migration would break it on dev with no safety net`,
      ).toBe(true);
      for (const dbColumn of dbColumns) {
        expect(
          REPAIR.includes(`"${dbColumn}"`),
          `column "${tableName}"."${dbColumn}" is missing from ` +
            `tools/repair-sql.mjs`,
        ).toBe(true);
      }
    },
  );

  it('recreates migration 0046 column constraints (UNIQUE + NOT NULL on invoice_number)', () => {
    // Migration 0046 applies ALTER COLUMN invoice_number SET NOT NULL and
    // ADD CONSTRAINT commission_invoices_invoice_number_unique AFTER the
    // backfill. A DB repaired by this script (rather than migrated forward)
    // must end up with the same constraints — ADD COLUMN IF NOT EXISTS
    // alone leaves invoice_number nullable with no uniqueness.
    expect(
      REPAIR.includes('ALTER COLUMN "invoice_number" SET NOT NULL'),
      'repair SQL must enforce NOT NULL on commission_invoices.invoice_number (migration 0046)',
    ).toBe(true);
    expect(
      REPAIR.includes('"commission_invoices_invoice_number_unique"'),
      'repair SQL must recreate the commission_invoices_invoice_number_unique constraint (migration 0046)',
    ).toBe(true);
  });

  it('creates every referenced table before its first foreign key (2026-09-28 P0)', () => {
    // Postgres requires the referenced table to EXIST when a FOREIGN KEY /
    // REFERENCES clause is created — `IF NOT EXISTS` on the column does not
    // save you. The 2026-09-28 deploy-dev failure: repair-sql.mjs added
    // admin_sessions.user_id REFERENCES users(id) BEFORE `users` was
    // created, so every dev deploy crashed with 'relation "users" does not
    // exist' and the users table never materialized.
    const createPositions = new Map<string, number>();
    for (const match of REPAIR.matchAll(
      /CREATE TABLE IF NOT EXISTS "([^"]+)"/g,
    )) {
      if (!createPositions.has(match[1])) {
        createPositions.set(match[1], match.index ?? -1);
      }
    }
    const violations: string[] = [];
    for (const match of REPAIR.matchAll(/REFERENCES "([^"]+)"/g)) {
      const referenced = match[1];
      const refPos = match.index ?? -1;
      const createPos = createPositions.get(referenced);
      if (createPos === undefined || createPos === -1) {
        violations.push(
          `REFERENCES "${referenced}" (offset ${refPos}) has no CREATE TABLE in the repair SQL`,
        );
      } else if (createPos > refPos) {
        violations.push(
          `REFERENCES "${referenced}" (offset ${refPos}) appears before ` +
            `its CREATE TABLE (offset ${createPos}) — Postgres would fail ` +
            `with 'relation "${referenced}" does not exist'`,
        );
      }
    }
    expect(violations).toEqual([]);
  });
});
