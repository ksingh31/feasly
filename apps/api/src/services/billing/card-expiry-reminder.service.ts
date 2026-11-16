/**
 * One-time card-expiry reminder (#880, #716 AC3 email half).
 *
 * Run once a day from the invoice-reviewer timer. For every tenant with a
 * payment-provider customer, read the card on file LIVE from the provider
 * (the default payment method, else the newest card — the same card the
 * charge path uses). When that card's expiry falls inside
 * BILLING_CARD_EXPIRY_WARNING_DAYS (`cardExpiryFlags().expiresSoon`, the
 * same rule the portal's "expires soon" notice uses), email the builder
 * org's active admins once.
 *
 * Exactly once per card: the card is claimed in `card_expiry_reminders`
 * (primary key = payment method id) BEFORE any email goes out, so a second
 * run, a host retry or a scaled-out instance finds the claim and sends
 * nothing. A replaced card has a new payment method id and gets its own
 * reminder when it enters the window. If every send for a claimed card
 * fails, the claim is released so tomorrow's run retries it.
 *
 * Skipped without a claim (so a later run can still remind):
 * - billing model is not `commission`, or no payment provider configured;
 * - no builder row for the tenant (seeded/test tenants), a `flat` plan, or
 *   a status whose policy refuses `autoCharge` (suspended, offboarded) —
 *   the card won't be charged, so there's nothing to warn about;
 * - no recipient (no active org admin and no builder contact email).
 *
 * One tenant's failure never kills the batch; a failure to list tenants
 * throws so the timer adapter reports CYCLE FAILED. No PII in logs.
 */
import type { Builder } from '@feasly/contracts';
import type { BillingConfig } from '../../config';
import { builderStatusAllows } from '../../lib/builder-status-policy';
import type { EmailService } from '../email/email.service';
import type { MembershipStore } from '../user.service';
import type { BillingAuditService } from './billing-audit.service';
import type { CardExpiryReminderStore } from './card-expiry-reminder.store';
import { cardExpiryFlags } from './commission-card.service';
import type { CardSummary, StripeService } from './stripe.service';

/** Default "expires soon" window when config omits it (#716). */
const DEFAULT_EXPIRY_WARNING_DAYS = 30;

export interface CardExpiryReminderResult {
  /** Tenants with a provider customer that were looked at. */
  readonly checked: number;
  /** Cards newly reminded this run (at least one email accepted). */
  readonly reminded: number;
  /** Reminder emails accepted by the email provider. */
  readonly emailsSent: number;
  /** Cards in the window that were already reminded on an earlier run. */
  readonly alreadyReminded: number;
  /** Tenants needing no reminder (no card, not in window, not eligible). */
  readonly skipped: number;
  /** Per-tenant failures (sanitized messages, no PII). */
  readonly errors: ReadonlyArray<{ readonly message: string }>;
}

export interface CardExpiryReminderService {
  /** One daily cycle. Throws only when the tenant list can't be read. */
  runReminderCycle(now: Date): Promise<CardExpiryReminderResult>;
}

export interface CardExpiryReminderServiceDeps {
  readonly billing: BillingConfig;
  readonly stripe: StripeService;
  readonly store: CardExpiryReminderStore;
  readonly email: Pick<EmailService, 'sendCardExpiryReminder'>;
  readonly builders: {
    getByTenantKey(tenantKey: string): Promise<Builder | null>;
  };
  readonly memberships: Pick<MembershipStore, 'listActiveOrgAdminEmails'>;
  readonly audit: BillingAuditService;
}

type TenantOutcome = 'reminded' | 'already' | 'skipped';

export function createCardExpiryReminderService(
  deps: CardExpiryReminderServiceDeps,
): CardExpiryReminderService {
  const { billing, stripe, store, email, builders, memberships, audit } = deps;
  const warningDays =
    billing.cardExpiryWarningDays ?? DEFAULT_EXPIRY_WARNING_DAYS;

  /** The card the charge path uses: the default, else the newest. */
  async function cardOnFile(customerId: string): Promise<CardSummary | null> {
    const cards = await stripe.listPaymentMethods(customerId);
    if (cards.length === 0) return null;
    const defaultId = await stripe.getDefaultPaymentMethodId(customerId);
    return cards.find((c) => c.id !== undefined && c.id === defaultId) ?? cards[0] ?? null;
  }

  async function recipientsFor(builder: Builder): Promise<string[]> {
    const recipients = new Set<string>();
    for (const address of await memberships.listActiveOrgAdminEmails(builder.id)) {
      const normalized = address.trim().toLowerCase();
      if (normalized) recipients.add(normalized);
    }
    // No active admin yet (pre-invite builders): the business contact email.
    if (recipients.size === 0 && builder.email?.trim()) {
      recipients.add(builder.email.trim().toLowerCase());
    }
    return [...recipients];
  }

  async function remindTenant(
    tenantKey: string,
    customerId: string,
    now: Date,
    counters: { emailsSent: number },
  ): Promise<TenantOutcome> {
    const builder = await builders.getByTenantKey(tenantKey);
    if (
      builder === null ||
      builder.plan === 'flat' ||
      !builderStatusAllows(builder.status, 'autoCharge')
    ) {
      return 'skipped';
    }
    const card = await cardOnFile(customerId);
    if (card === null || !card.id) return 'skipped';
    if (!cardExpiryFlags(card, now, warningDays).expiresSoon) return 'skipped';

    const recipients = await recipientsFor(builder);
    if (recipients.length === 0) return 'skipped';

    const claimed = await store.claim({
      paymentMethodId: card.id,
      tenantKey,
      expMonth: card.expMonth,
      expYear: card.expYear,
    });
    if (!claimed) return 'already';

    let delivered = 0;
    let lastError: unknown;
    for (const to of recipients) {
      try {
        const delivery = await email.sendCardExpiryReminder({
          to,
          businessName: builder.businessName,
          brand: card.brand,
          last4: card.last4,
          expMonth: card.expMonth,
          expYear: card.expYear,
        });
        if (delivery.sent) delivered += 1;
      } catch (error) {
        lastError = error;
      }
    }
    if (delivered === 0) {
      // Nothing went out — release so tomorrow's run retries this card.
      await store.release(card.id);
      throw lastError instanceof Error
        ? lastError
        : new Error('card-expiry reminder: no email was accepted');
    }
    counters.emailsSent += delivered;
    await audit.append({
      tenantKey,
      eventType: 'card.expiry_reminder_sent',
      entityType: 'stripe_payment_method',
      entityId: card.id,
      payload: {
        customerId,
        expMonth: card.expMonth,
        expYear: card.expYear,
        recipients: delivered,
      },
    });
    return 'reminded';
  }

  return {
    async runReminderCycle(now: Date): Promise<CardExpiryReminderResult> {
      const empty: CardExpiryReminderResult = {
        checked: 0,
        reminded: 0,
        emailsSent: 0,
        alreadyReminded: 0,
        skipped: 0,
        errors: [],
      };
      if (billing.model !== 'commission' || !stripe.isConfigured) return empty;

      const customers = await store.listCustomers();
      const counters = { emailsSent: 0 };
      let reminded = 0;
      let alreadyReminded = 0;
      let skipped = 0;
      const errors: { message: string }[] = [];
      for (const { tenantKey, customerId } of customers) {
        try {
          const outcome = await remindTenant(tenantKey, customerId, now, counters);
          if (outcome === 'reminded') reminded += 1;
          else if (outcome === 'already') alreadyReminded += 1;
          else skipped += 1;
        } catch (error) {
          errors.push({
            message: error instanceof Error ? error.message : 'unknown error',
          });
        }
      }
      return {
        checked: customers.length,
        reminded,
        emailsSent: counters.emailsSent,
        alreadyReminded,
        skipped,
        errors,
      };
    },
  };
}
