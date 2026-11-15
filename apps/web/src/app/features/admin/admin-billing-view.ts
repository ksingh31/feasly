/**
 * Admin Billing overview (#544) — pure view helpers. No Angular, no state.
 */
import type { BillingHealthResponse, Builder } from '@feasly/contracts';
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
