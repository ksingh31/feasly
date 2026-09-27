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
});
