/**
 * Drizzle-backed email outbox (#750 daily email cap).
 *
 * Over-cap messages are parked here by the email service and drained by the
 * email-outbox timer. Rows hold a recipient address and a rendered body, so
 * the drain deletes them as soon as they are sent; stale rows are purged.
 * Only services import from this module (layer boundary).
 */
import { randomUUID } from 'node:crypto';
import { asc, eq, lt, sql } from 'drizzle-orm';
import { emailOutbox } from '../db/schema';
import type { EmailMessage } from './email/email.types';
import type { EmailOutboxQueue } from './email/email.service';

export interface EmailOutboxRow {
  readonly id: string;
  readonly message: EmailMessage;
  readonly attempts: number;
  readonly createdAt: Date;
}

export interface EmailOutboxStore extends EmailOutboxQueue {
  /** Oldest-first pending rows. */
  listPending(limit: number): Promise<EmailOutboxRow[]>;
  /** Remove a row (sent, or permanently undeliverable). */
  remove(id: string): Promise<void>;
  /** Record a transient failure; the row stays queued. */
  recordFailure(id: string, reason: string): Promise<void>;
  /** Drop rows created before `cutoff`; returns how many were removed. */
  deleteOlderThan(cutoff: Date): Promise<number>;
}

export interface DrizzleEmailOutboxStoreDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
}

export function createDrizzleEmailOutboxStore(
  deps: DrizzleEmailOutboxStoreDeps,
): EmailOutboxStore {
  const { db } = deps;
  const t = emailOutbox;
  return {
    async enqueue(message: EmailMessage, now: Date): Promise<void> {
      await db.insert(t).values({
        id: randomUUID(),
        toAddress: message.to,
        subject: message.subject,
        html: message.html,
        bodyText: message.text,
        headers: message.headers ? { ...message.headers } : null,
        createdAt: now,
      });
    },

    async listPending(limit: number): Promise<EmailOutboxRow[]> {
      const rows: Array<typeof t.$inferSelect> = await db
        .select()
        .from(t)
        .orderBy(asc(t.createdAt))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        message: {
          to: row.toAddress,
          subject: row.subject,
          html: row.html,
          text: row.bodyText,
          ...(row.headers ? { headers: row.headers } : {}),
        },
        attempts: row.attempts,
        createdAt: row.createdAt,
      }));
    },

    async remove(id: string): Promise<void> {
      await db.delete(t).where(eq(t.id, id));
    },

    async recordFailure(id: string, reason: string): Promise<void> {
      await db
        .update(t)
        .set({ attempts: sql`${t.attempts} + 1`, lastError: reason })
        .where(eq(t.id, id));
    },

    async deleteOlderThan(cutoff: Date): Promise<number> {
      const rows: unknown[] = await db
        .delete(t)
        .where(lt(t.createdAt, cutoff))
        .returning({ id: t.id });
      return rows.length;
    },
  };
}
