/**
 * Storage for the simulated payment provider (#753).
 *
 * One row per Stripe-shaped object in `simulated_payment_objects`. The
 * Postgres store keeps a saved test card across Functions scale-to-zero;
 * the in-memory store backs unit tests.
 *
 * Only services and composition.ts may import from src/db/ — enforced by
 * test/boundaries.test.ts.
 */
import { and, asc, desc, eq, isNull, lte } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { simulatedPaymentObjects } from '../../db/schema';

export interface SimulatedObject {
  readonly id: string;
  /** customer | setup_intent | payment_method | payment_intent | … | event */
  readonly objectType: string;
  readonly customerId: string | null;
  readonly data: Record<string, unknown>;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
}

export interface SimulatedPaymentStore {
  get(id: string): Promise<SimulatedObject | null>;
  /** Insert; false when the id already exists (idempotent create). */
  insert(object: {
    id: string;
    objectType: string;
    customerId: string | null;
    data: Record<string, unknown>;
    createdAt: Date;
  }): Promise<boolean>;
  update(
    id: string,
    patch: { data: Record<string, unknown>; customerId?: string | null },
  ): Promise<void>;
  /** Objects of one type owned by a customer, newest first. */
  listByCustomer(
    customerId: string,
    objectType: string,
  ): Promise<SimulatedObject[]>;
  /** Undelivered events created at or before `createdBefore`, oldest first. */
  listUndeliveredEvents(createdBefore: Date): Promise<SimulatedObject[]>;
  markDelivered(id: string, at: Date): Promise<void>;
}

export function createDrizzleSimulatedPaymentStore(
  db: AppDb,
): SimulatedPaymentStore {
  const t = simulatedPaymentObjects;
  const toObject = (row: typeof t.$inferSelect): SimulatedObject => ({
    id: row.id,
    objectType: row.objectType,
    customerId: row.customerId,
    data: row.data,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
  });
  return {
    async get(id) {
      const row = await db.query.simulatedPaymentObjects.findFirst({
        where: eq(t.id, id),
      });
      return row ? toObject(row) : null;
    },
    async insert(object) {
      const inserted = await db
        .insert(t)
        .values(object)
        .onConflictDoNothing({ target: t.id })
        .returning({ id: t.id });
      return inserted.length > 0;
    },
    async update(id, patch) {
      await db
        .update(t)
        .set({
          data: patch.data,
          ...(patch.customerId !== undefined
            ? { customerId: patch.customerId }
            : {}),
        })
        .where(eq(t.id, id));
    },
    async listByCustomer(customerId, objectType) {
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.customerId, customerId), eq(t.objectType, objectType)))
        .orderBy(desc(t.createdAt), desc(t.id));
      return rows.map(toObject);
    },
    async listUndeliveredEvents(createdBefore) {
      const rows = await db
        .select()
        .from(t)
        .where(
          and(
            eq(t.objectType, 'event'),
            isNull(t.deliveredAt),
            lte(t.createdAt, createdBefore),
          ),
        )
        .orderBy(asc(t.createdAt), asc(t.id))
        .limit(100);
      return rows.map(toObject);
    },
    async markDelivered(id, at) {
      await db.update(t).set({ deliveredAt: at }).where(eq(t.id, id));
    },
  };
}

/** In-memory store for unit tests (same semantics as the Postgres one). */
export function createInMemorySimulatedPaymentStore(): SimulatedPaymentStore {
  const rows = new Map<string, SimulatedObject>();
  let seq = 0;
  const order = new Map<string, number>();
  const newestFirst = (a: SimulatedObject, b: SimulatedObject): number =>
    b.createdAt.getTime() - a.createdAt.getTime() ||
    (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0);
  return {
    async get(id) {
      return rows.get(id) ?? null;
    },
    async insert(object) {
      if (rows.has(object.id)) return false;
      rows.set(object.id, { ...object, deliveredAt: null });
      order.set(object.id, ++seq);
      return true;
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) return;
      rows.set(id, {
        ...row,
        data: patch.data,
        ...(patch.customerId !== undefined
          ? { customerId: patch.customerId }
          : {}),
      });
    },
    async listByCustomer(customerId, objectType) {
      return [...rows.values()]
        .filter((r) => r.customerId === customerId && r.objectType === objectType)
        .sort(newestFirst);
    },
    async listUndeliveredEvents(createdBefore) {
      return [...rows.values()]
        .filter(
          (r) =>
            r.objectType === 'event' &&
            r.deliveredAt === null &&
            r.createdAt.getTime() <= createdBefore.getTime(),
        )
        .sort((a, b) => -newestFirst(a, b));
    },
    async markDelivered(id, at) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, deliveredAt: at });
    },
  };
}
