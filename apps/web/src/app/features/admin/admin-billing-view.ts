/**
 * Admin Billing overview (#544) — pure view helpers. No Angular, no state.
 */
import type {
  BillingHealthDunningInvoice,
  BillingHealthInReviewInvoice,
  BillingHealthResponse,
  Builder,
} from '@feasly/contracts';
import type { AdminCopy } from '@app/core/config/app-config';
import type { StripeModeKey, UiConfirmOptions } from '@app/shared/ui';
import { formatCentsToCad } from '../../shared/utils/money';

/** Header chip key for the configured Stripe key. */
export function stripeModeKey(stripe: BillingHealthResponse['stripe']): StripeModeKey {
  if (!stripe.configured) return 'not_configured';
  return stripe.testMode ? 'test' : 'live';
}

/**
 * Builder name for a tenant key, from the loaded builder list. Falls back
 * to the tenant key while builders load (or for a builder since removed).
 */
export function builderNameFor(
  builders: readonly Pick<Builder, 'tenantKey' | 'displayName' | 'businessName'>[],
  tenantKey: string,
): string {
  const builder = builders.find((b) => b.tenantKey === tenantKey);
  return builder?.displayName || builder?.businessName || tenantKey;
}

/** "1.5%" — trims float dust from stored percents. */
export function ratePercentLabel(rate: number): string {
  return `${Number(rate.toFixed(4))}%`;
}

/**
 * Whole days between `now` and an ISO timestamp (dunning age). Integer
 * math on the epoch — no float rounding surprises.
 */
export function daysOverdue(iso: string, now: Date = new Date()): number {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

/** True when the invoice has used all its charge retries. */
export function retriesExhausted(retryCount: number, maxRetries: number | undefined): boolean {
  return maxRetries !== undefined && retryCount >= maxRetries;
}

/** "Retry 2 of 3" — the next attempt against the cap; plain label when unknown. */
export function retryLabel(retryCount: number, maxRetries: number | undefined): string {
  const attempt = nextAttempt(retryCount, maxRetries);
  return attempt === null ? 'Retry charge' : `Retry ${attempt}`;
}

/** "2 of 3" — the next retry against the cap, or null when the cap is unknown. */
function nextAttempt(retryCount: number, maxRetries: number | undefined): string | null {
  if (maxRetries === undefined || maxRetries <= 0) return null;
  const next = Math.min(retryCount + 1, maxRetries);
  return `${next} of ${maxRetries}`;
}

/**
 * ConfirmDialog copy for a charge retry (portal-ui-kit §3: money actions
 * name the amount and the builder).
 */
export function retryConfirmOptions(input: {
  builderName: string;
  commissionCents: number;
  retryCount: number;
  maxRetries: number | undefined;
}): UiConfirmOptions {
  const amount = formatCentsToCad(input.commissionCents);
  const builder = input.builderName;
  const attempt = nextAttempt(input.retryCount, input.maxRetries);
  const charge = `We'll charge ${amount} to ${builder}'s card now.`;
  return {
    title: `Retry ${amount} charge for ${builder}?`,
    body: attempt === null ? charge : `${charge} This is retry ${attempt}.`,
    verb: 'Retry charge',
  };
}

/** `{key}` placeholders → values. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

type DunningCopy = AdminCopy['dunning'];

/** #901: the row is flagged for collections (final automatic retry failed). */
export function inCollections(row: Pick<BillingHealthDunningInvoice, 'collectionsAt'>): boolean {
  return !!row.collectionsAt;
}

/**
 * #901: collections rows first (oldest flag first), then the API's order.
 * The API already sorts this way; re-sorting here keeps the guarantee if
 * the payload ever arrives unsorted. Stable — never reorders the rest.
 */
export function sortDunningRows(rows: readonly BillingHealthDunningInvoice[]): BillingHealthDunningInvoice[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ac = a.row.collectionsAt ? Date.parse(a.row.collectionsAt) : null;
      const bc = b.row.collectionsAt ? Date.parse(b.row.collectionsAt) : null;
      if (ac !== null && bc !== null && ac !== bc) return ac - bc;
      if (ac !== null && bc === null) return -1;
      if (ac === null && bc !== null) return 1;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

/**
 * #901: the row's schedule state — "Collections · 4 days" (age since the
 * flag) when flagged, else Active / Paused / Cancelled.
 */
export function dunningStateLabel(
  row: Pick<BillingHealthDunningInvoice, 'collectionsAt' | 'dunningState'>,
  copy: DunningCopy,
  now: Date = new Date(),
): string {
  if (row.collectionsAt) {
    const days = daysOverdue(row.collectionsAt, now);
    return days === 1 ? copy.collectionsOne : fill(copy.collectionsMany, { days: String(days) });
  }
  switch (row.dunningState ?? 'active') {
    case 'paused':
      return copy.statePaused;
    case 'cancelled':
      return copy.stateCancelled;
    default:
      return copy.stateActive;
  }
}

/** #901: "7 days" / "1 day"; the "none" copy when the API sent no value. */
export function graceDaysLabel(days: number | undefined, copy: DunningCopy): string {
  if (days === undefined) return copy.notOverdue;
  return days === 1 ? copy.graceOne : fill(copy.graceMany, { days: String(days) });
}

/**
 * #901: "Awaiting manual payment — N days" for a manual-method invoice
 * past its due date (server's `overdueDays`); the dash otherwise.
 */
export function awaitingManualLabel(
  row: Pick<BillingHealthInReviewInvoice, 'paymentMethod' | 'overdueDays'>,
  copy: DunningCopy,
): string {
  const days = row.paymentMethod === 'card' ? 0 : Math.floor(row.overdueDays ?? 0);
  if (!(days > 0)) return copy.notOverdue;
  return days === 1 ? copy.awaitingManualOne : fill(copy.awaitingManualMany, { days: String(days) });
}

/** #901: the grace-days input as a whole number within bounds, or null. */
export function parseGraceDays(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return Number.isInteger(days) && days >= min && days <= max ? days : null;
}

/** #901: ConfirmDialog copy for cancelling an invoice's automatic retries. */
export function cancelRetriesConfirmOptions(
  input: { builderName: string; commissionCents: number },
  copy: DunningCopy,
): UiConfirmOptions {
  const values = { builder: input.builderName, amount: formatCentsToCad(input.commissionCents) };
  return {
    title: fill(copy.cancelTitle, values),
    body: fill(copy.cancelBody, values),
    verb: copy.cancelVerb,
    tone: 'danger',
  };
}
