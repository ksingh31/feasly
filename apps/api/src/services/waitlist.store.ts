/**
 * Waitlist persistence (#520).
 *
 * One row per (email, topic). `insertIfAbsent` is idempotent: a repeat
 * signup hits the unique index and is silently skipped, so callers never
 * learn whether the email was already on the list. `listByEmail` /
 * `deleteByEmail` back the PIPEDA privacy export and erasure.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { waitlistSignups } from '../db/schema';

export interface WaitlistSignupRecord {
  readonly id: string;
  readonly email: string;
  /** 'renovation' | 'toronto' | 'vancouver' (contracts WaitlistTopic). */
  readonly topic: string;
  readonly createdAt: Date;
  /** CASL consent timestamp captured at signup. */
  readonly consentTs: Date;
  /** Version tag of the consent wording agreed to; null = unknown. */
  readonly consentVersion: string | null;
}

export interface NewWaitlistSignup {
  readonly id: string;
  /** Already trimmed + lowercased by the service. */
  readonly email: string;
  readonly topic: string;
  /** Version tag of the consent wording shown (legal-copy.ts). */
  readonly consentVersion: string;
}

export interface WaitlistStore {
  /** Inserts the signup; a duplicate (email, topic) is a no-op. */
  insertIfAbsent(signup: NewWaitlistSignup): Promise<void>;
  /** The stored signup for (email, topic), or null. */
  find(email: string, topic: string): Promise<WaitlistSignupRecord | null>;
  /** Every signup for a normalized email (privacy export), oldest first. */
  listByEmail(email: string): Promise<readonly WaitlistSignupRecord[]>;
  /** Hard-deletes every signup for a normalized email (privacy erasure). Returns the count. */
  deleteByEmail(email: string): Promise<number>;
}

function toRecord(row: typeof waitlistSignups.$inferSelect): WaitlistSignupRecord {
  return {
    id: row.id,
    email: row.email,
    topic: row.topic,
    createdAt: row.createdAt,
    consentTs: row.consentTs,
    consentVersion: row.consentVersion,
  };
}

export interface DrizzleWaitlistStoreDeps {
  readonly db: AppDb;
}

export function createDrizzleWaitlistStore(deps: DrizzleWaitlistStoreDeps): WaitlistStore {
  const { db } = deps;
  return {
    async insertIfAbsent(signup: NewWaitlistSignup): Promise<void> {
      await db
        .insert(waitlistSignups)
        .values({
          id: signup.id,
          email: signup.email,
          topic: signup.topic,
          consentVersion: signup.consentVersion,
        })
        .onConflictDoNothing({ target: [waitlistSignups.email, waitlistSignups.topic] });
    },

    async find(email: string, topic: string): Promise<WaitlistSignupRecord | null> {
      const rows = await db
        .select()
        .from(waitlistSignups)
        .where(and(eq(waitlistSignups.email, email), eq(waitlistSignups.topic, topic)))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async listByEmail(email: string): Promise<readonly WaitlistSignupRecord[]> {
      const rows = await db
        .select()
        .from(waitlistSignups)
        .where(eq(waitlistSignups.email, email))
        .orderBy(asc(waitlistSignups.createdAt));
      return rows.map(toRecord);
    },

    async deleteByEmail(email: string): Promise<number> {
      const deleted = await db
        .delete(waitlistSignups)
        .where(eq(waitlistSignups.email, email))
        .returning({ id: waitlistSignups.id });
      return deleted.length;
    },
  };
}
