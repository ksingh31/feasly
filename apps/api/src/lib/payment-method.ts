/**
 * Builder-selectable payment methods (billing/12), shared by the
 * commission service and the builder service.
 *
 * Pure helpers only: no db, no config, no I/O. The type itself lives in
 * `@feasly/contracts` (billing.ts); this module holds the runtime list
 * and the settings read/validate helpers the services need.
 */
import { ErrorCodes, HttpError } from '../middleware/errors';
import type { BuilderPaymentMethod } from '@feasly/contracts';

/** All builder-selectable payment methods, in display order. */
export const BUILDER_PAYMENT_METHODS: ReadonlyArray<BuilderPaymentMethod> = [
  'card',
  'cheque',
  'e_transfer',
  'bank_draft',
];

/**
 * Read a builder-selectable payment method out of
 * `builders.settings.defaultPaymentMethod`. Anything that isn't one of
 * the four known values → 'card' (fail safe: the only behavior that
 * existed before).
 */
export function readDefaultPaymentMethod(
  settings: Record<string, unknown> | null | undefined,
): BuilderPaymentMethod {
  const raw = settings?.['defaultPaymentMethod'];
  return (BUILDER_PAYMENT_METHODS as ReadonlyArray<string>).includes(
    typeof raw === 'string' ? raw : '',
  )
    ? (raw as BuilderPaymentMethod)
    : 'card';
}

/** 400 unless `method` is one of the four known payment methods. */
export function requireKnownPaymentMethod(
  method: unknown,
): BuilderPaymentMethod {
  if (
    !(BUILDER_PAYMENT_METHODS as ReadonlyArray<string>).includes(
      typeof method === 'string' ? method : '',
    )
  ) {
    throw new HttpError(
      400,
      ErrorCodes.VALIDATION_FAILED,
      `Unknown payment method "${String(method)}" — expected one of: ${BUILDER_PAYMENT_METHODS.join(', ')}`,
    );
  }
  return method as BuilderPaymentMethod;
}
