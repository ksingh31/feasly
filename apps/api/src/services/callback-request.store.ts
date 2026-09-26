/**
 * Callback-request persistence (phase-2 wiring).
 *
 * A "call me back" ask attached to a report. The reportToken resolves to
 * the lead at request time — only the leadId is persisted (the token itself
 * is a bearer credential and is never stored). Rows are insert-only; the
 * team works them via the future inbox flow (`status` pending → done).
 */
import { desc, eq } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { callbackRequests } from '../db/schema';

export interface CallbackRequestRecord {
  readonly id: string;
  readonly leadId: string;
  readonly name: string;
  readonly phone: string;
  /** 'morning' | 'afternoon' | 'evening' (contracts CallbackWindow). */
  readonly window: string;
  readonly status: string;
  readonly createdAt: Date;
}

export interface NewCallbackRequest {
  readonly id: string;
  readonly leadId: string;
  readonly name: string;
  readonly phone: string;
  readonly window: string;
}

export interface CallbackRequestStore {
  insert(request: NewCallbackRequest): Promise<CallbackRequestRecord>;
  /** Latest requests for a lead, newest first (admin/inbox views). */
  listByLeadId(leadId: string): Promise<readonly CallbackRequestRecord[]>;
}

type CallbackRow = typeof callbackRequests.$inferSelect;

function toRecord(row: CallbackRow): CallbackRequestRecord {
  return {
    id: row.id,
    leadId: row.leadId,
    name: row.name,
    phone: row.phone,
    window: row.window,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export interface DrizzleCallbackRequestStoreDeps {
  readonly db: AppDb;
}

export function createDrizzleCallbackRequestStore(
  deps: DrizzleCallbackRequestStoreDeps,
): CallbackRequestStore {
  const { db } = deps;
  return {
    async insert(request: NewCallbackRequest): Promise<CallbackRequestRecord> {
      const rows = await db
        .insert(callbackRequests)
        .values({
          id: request.id,
          leadId: request.leadId,
          name: request.name,
          phone: request.phone,
          window: request.window,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('callback request insert returned no row');
      return toRecord(row);
    },

    async listByLeadId(leadId: string): Promise<readonly CallbackRequestRecord[]> {
      const rows = await db
        .select()
        .from(callbackRequests)
        .where(eq(callbackRequests.leadId, leadId))
        .orderBy(desc(callbackRequests.createdAt));
      return rows.map(toRecord);
    },
  };
}
