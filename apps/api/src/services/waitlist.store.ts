/**
 * Waitlist persistence (#520).
 *
 * One row per (email, topic). `insertIfAbsent` is idempotent: a repeat
 * signup hits the unique index and is silently skipped, so callers never
 * learn whether the email was already on the list.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDb } from '../db/client';
import { waitlistSignups } from '../db/schema';

export interface WaitlistSignupRecord {
  readonly id: string;
  readonly email: string;
  /** 'renovation' | 'toronto' | 'vancouver' (contracts WaitlistTopic). */
  readonly topic: string;
  readonly createdAt: Date;
}

export interface NewWaitlistSignup {
  readonly id: string;
  /** Already trimmed + lowercased by the service. */
  readonly email: string;
  readonly topic: string;
}

export interface WaitlistStore {
  /** Inserts the signup; a duplicate (email, topic) is a no-op. */
  insertIfAbsent(signup: NewWaitlistSignup): Promise<void>;
  /** The stored signup for (email, topic), or null. */
  find(email: string, topic: string): Promise<WaitlistSignupRecord | null>;
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
        .values({ id: signup.id, email: signup.email, topic: signup.topic })
        .onConflictDoNothing({ target: [waitlistSignups.email, waitlistSignups.topic] });
    },

    async find(email: string, topic: string): Promise<WaitlistSignupRecord | null> {
      const rows = await db
        .select()
        .from(waitlistSignups)
        .where(and(eq(waitlistSignups.email, email), eq(waitlistSignups.topic, topic)))
        .limit(1);
      const row = rows[0];
      return row
        ? { id: row.id, email: row.email, topic: row.topic, createdAt: row.createdAt }
        : null;
    },
  };
}
