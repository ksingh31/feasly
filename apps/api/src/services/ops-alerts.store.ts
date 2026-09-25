/**
 * Drizzle-backed OpsAlertStore (admin/06).
 *
 * Only services import from this module (layer boundary: routes and
 * middleware never touch the db directly).
 */
import { eq } from 'drizzle-orm';
import { opsAlertState } from '../db/schema';

/** Dedupe/all-clear state for one alert class. */
export interface OpsAlertStateRecord {
  readonly type: string;
  readonly lastFiredAt: Date | null;
  readonly lastRecoveredAt: Date | null;
}

export interface OpsAlertStore {
  findByType(type: string): Promise<OpsAlertStateRecord | null>;
  /**
   * Insert-or-update the row for a type. `lastFiredAt` /
   * `lastRecoveredAt` are set explicitly by the caller; passing undefined
   * leaves the existing value untouched.
   */
  upsert(args: {
    readonly type: string;
    readonly lastFiredAt?: Date | null;
    readonly lastRecoveredAt?: Date | null;
  }): Promise<OpsAlertStateRecord>;
}

export interface DrizzleOpsAlertStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

function toRecord(row: typeof opsAlertState.$inferSelect): OpsAlertStateRecord {
  return {
    type: row.type,
    lastFiredAt: row.lastFiredAt,
    lastRecoveredAt: row.lastRecoveredAt,
  };
}

export function createDrizzleOpsAlertStore(
  deps: DrizzleOpsAlertStoreDeps,
): OpsAlertStore {
  const { db } = deps;
  return {
    async findByType(type: string): Promise<OpsAlertStateRecord | null> {
      const rows = await db
        .select()
        .from(opsAlertState)
        .where(eq(opsAlertState.type, type))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async upsert(args): Promise<OpsAlertStateRecord> {
      const set: {
        lastFiredAt?: Date | null;
        lastRecoveredAt?: Date | null;
      } = {};
      if (args.lastFiredAt !== undefined) set.lastFiredAt = args.lastFiredAt;
      if (args.lastRecoveredAt !== undefined)
        set.lastRecoveredAt = args.lastRecoveredAt;
      const rows = await db
        .insert(opsAlertState)
        .values({
          type: args.type,
          lastFiredAt: args.lastFiredAt ?? null,
          lastRecoveredAt: args.lastRecoveredAt ?? null,
        })
        .onConflictDoUpdate({
          target: opsAlertState.type,
          set,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('ops_alert_state upsert returned no row');
      return toRecord(row);
    },
  };
}
