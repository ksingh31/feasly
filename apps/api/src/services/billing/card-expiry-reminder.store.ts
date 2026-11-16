/**
 * Drizzle-backed store for the one-time card-expiry reminder (#880).
 *
 * - `listCustomers` — every tenant with a saved payment-provider customer
 *   (the only tenants that can have a card on file).
 * - `claim` / `release` — the per-card dedupe. `claim` is an
 *   `INSERT … ON CONFLICT DO NOTHING RETURNING` on the
 *   `card_expiry_reminders` primary key, so exactly one caller wins per
 *   payment method id, across timer retries and scaled-out instances.
 *
 * Only services and composition.ts import from src/db/ (layer boundary).
 */
import { eq, isNotNull } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { cardExpiryReminders, tenants } from '../../db/schema';

export interface CardReminderCustomer {
  readonly tenantKey: string;
  readonly customerId: string;
}

export interface CardReminderClaim {
  readonly paymentMethodId: string;
  readonly tenantKey: string;
  readonly expMonth: number;
  readonly expYear: number;
}

export interface CardExpiryReminderStore {
  /** Tenants with a payment-provider customer id, ordered by tenant key. */
  listCustomers(): Promise<readonly CardReminderCustomer[]>;
  /**
   * Atomically claim the reminder for a card. True only for the one caller
   * that inserted the row; false when the card was already reminded.
   */
  claim(input: CardReminderClaim): Promise<boolean>;
  /** Drop a claim whose send failed, so a later run can retry it. */
  release(paymentMethodId: string): Promise<void>;
}

export function createDrizzleCardExpiryReminderStore(deps: {
  readonly db: AppDb;
}): CardExpiryReminderStore {
  const { db } = deps;
  return {
    async listCustomers() {
      const rows = await db
        .select({
          tenantKey: tenants.tenantKey,
          customerId: tenants.stripeCustomerId,
        })
        .from(tenants)
        .where(isNotNull(tenants.stripeCustomerId))
        .orderBy(tenants.tenantKey);
      return rows.flatMap((r) =>
        r.customerId ? [{ tenantKey: r.tenantKey, customerId: r.customerId }] : [],
      );
    },

    async claim(input) {
      const inserted = await db
        .insert(cardExpiryReminders)
        .values({
          paymentMethodId: input.paymentMethodId,
          tenantKey: input.tenantKey,
          expMonth: input.expMonth,
          expYear: input.expYear,
        })
        .onConflictDoNothing({ target: cardExpiryReminders.paymentMethodId })
        .returning({ paymentMethodId: cardExpiryReminders.paymentMethodId });
      return inserted.length > 0;
    },

    async release(paymentMethodId) {
      await db
        .delete(cardExpiryReminders)
        .where(eq(cardExpiryReminders.paymentMethodId, paymentMethodId));
    },
  };
}
