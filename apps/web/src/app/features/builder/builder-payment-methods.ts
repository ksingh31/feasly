import type { BuilderCopy } from '../../core/config/app-config';

/**
 * Builder-facing payment methods (billing/12).
 *
 * `card` is the card on file (the scheduled Stripe auto-charge); the rest
 * are manual methods — choosing one pauses the auto-charge until staff
 * confirm the payment. Mirrors the backend's builder payment-method
 * contract exactly: GET/PUT /api/v1/billing/payment-method (the builder's
 * default for new invoices) and
 * PUT /api/v1/billing/invoices/{id}/payment-method (per-invoice override).
 */
export type BuilderPaymentMethod =
  | 'card'
  | 'cheque'
  | 'e_transfer'
  | 'bank_draft';

/** All builder payment methods, in display order. */
export const BUILDER_PAYMENT_METHODS: readonly BuilderPaymentMethod[] = [
  'card',
  'cheque',
  'e_transfer',
  'bank_draft',
];

/** Runtime guard for values coming from <select> change events. */
export function isBuilderPaymentMethod(
  value: unknown,
): value is BuilderPaymentMethod {
  return (
    value === 'card' ||
    value === 'cheque' ||
    value === 'e_transfer' ||
    value === 'bank_draft'
  );
}

/**
 * Buyer-grade label for a payment method. The card label carries the
 * on-file last4 when known ("Card •••• 4242").
 */
export function paymentMethodLabel(
  method: BuilderPaymentMethod,
  copy: Pick<
    BuilderCopy,
    | 'billingMethodCard'
    | 'billingMethodCardWithLast4'
    | 'billingMethodCheque'
    | 'billingMethodETransfer'
    | 'billingMethodBankDraft'
  >,
  last4?: string | null,
): string {
  switch (method) {
    case 'card':
      return last4
        ? copy.billingMethodCardWithLast4.replace('{last4}', last4)
        : copy.billingMethodCard;
    case 'cheque':
      return copy.billingMethodCheque;
    case 'e_transfer':
      return copy.billingMethodETransfer;
    case 'bank_draft':
      return copy.billingMethodBankDraft;
  }
}
