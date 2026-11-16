import type { CardOnFileStatus } from '@feasly/contracts';
import type { BuilderCardLifecycleCopy } from '../../core/config/app-config';

/** "08/28" from month 8 / year 2028; null when either part is missing. */
export function cardExpiry(card: CardOnFileStatus | null | undefined): string | null {
  if (!card?.expMonth || !card.expYear) {
    return null;
  }
  const mm = String(card.expMonth).padStart(2, '0');
  const yy = String(card.expYear).slice(-2);
  return `${mm}/${yy}`;
}

/** #879: the expiry notice shown above the card on Money / Billing. */
export interface CardLifecycleNotice {
  readonly kind: 'expiring' | 'expired';
  readonly heading: string;
  readonly body: string;
}

/**
 * #879: expiry notice for the card on file, or null. Renders the API's
 * `expired` / `expiresSoon` flags only — the warning window is server-side
 * (BILLING_CARD_EXPIRY_WARNING_DAYS); no date math here. `expired` wins
 * when both are set.
 */
export function cardLifecycleNotice(
  card: CardOnFileStatus | null | undefined,
  copy: BuilderCardLifecycleCopy,
): CardLifecycleNotice | null {
  if (!card?.hasCard || (!card.expired && !card.expiresSoon)) {
    return null;
  }
  const fill = (template: string): string =>
    template.replace('{last4}', card.last4 ?? '—').replace('{exp}', cardExpiry(card) ?? '—');
  return card.expired
    ? { kind: 'expired', heading: copy.expiredHeading, body: fill(copy.expiredBody) }
    : { kind: 'expiring', heading: copy.expiresSoonHeading, body: fill(copy.expiresSoonBody) };
}
