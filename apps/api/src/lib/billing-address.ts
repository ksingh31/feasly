/**
 * #881: builder billing address — validation + normalization (pure).
 *
 * The address is sent to the builder's Stripe customer (receipts, tax,
 * dispute evidence). `country` defaults to `CA`. A CA address must use one
 * of the 13 province/territory codes and a valid postal code; the postal
 * code is stored as upper-case `A1A 1A1`. Other countries get length checks
 * only (no per-country rules — the pilot is Calgary).
 */
import { z } from 'zod';
import type { BuilderBillingAddress } from '@feasly/contracts';

/** Canadian province + territory codes (Canada Post). */
export const CA_PROVINCE_CODES = [
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
] as const;

/**
 * Canada Post postal code: letter-digit-letter digit-letter-digit, optional
 * space/hyphen. D, F, I, O, Q, U never appear; W and Z never lead.
 */
const CA_POSTAL_RE =
  /^[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z][ -]?[0-9][ABCEGHJ-NPRSTV-Z][0-9]$/;

/** True for a valid Canadian postal code (case-insensitive). */
export function isCanadianPostalCode(value: string): boolean {
  return CA_POSTAL_RE.test(value.trim().toUpperCase());
}

/** `t2p1j9` / `T2P-1J9` → `T2P 1J9`. Call only on a valid code. */
export function normalizeCanadianPostalCode(value: string): string {
  const compact = value.trim().toUpperCase().replace(/[ -]/g, '');
  return `${compact.slice(0, 3)} ${compact.slice(3)}`;
}

const blankToNull = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? null : v;

/** Zod schema for `BuilderBillingAddressInput` → normalized address. */
export const billingAddressSchema = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: z.preprocess(blankToNull, z.string().trim().max(200).nullish()),
    city: z.string().trim().min(1).max(100),
    province: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().min(1).max(20),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'must be a two-letter country code')
      .optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if ((a.country ?? 'CA').toUpperCase() !== 'CA') return;
    if (!(CA_PROVINCE_CODES as readonly string[]).includes(a.province.toUpperCase())) {
      ctx.addIssue({
        code: 'custom',
        path: ['province'],
        message: 'must be a Canadian province code, e.g. AB',
      });
    }
    if (!isCanadianPostalCode(a.postalCode)) {
      ctx.addIssue({
        code: 'custom',
        path: ['postalCode'],
        message: 'must be a Canadian postal code, e.g. T2P 1J9',
      });
    }
  })
  .transform((a): BuilderBillingAddress => {
    const country = (a.country ?? 'CA').toUpperCase();
    const isCa = country === 'CA';
    return {
      line1: a.line1,
      line2: a.line2 ?? null,
      city: a.city,
      province: isCa ? a.province.toUpperCase() : a.province,
      postalCode: isCa
        ? normalizeCanadianPostalCode(a.postalCode)
        : a.postalCode.toUpperCase(),
      country,
    };
  });

/** Optional + nullable billing address field (omitted = unchanged, null = clear). */
export const billingAddressFieldSchema = z.preprocess(
  (v) => (v === '' ? null : v),
  billingAddressSchema.nullable(),
).optional();

/** Structural equality of two stored addresses (null-safe). */
export function sameBillingAddress(
  a: BuilderBillingAddress | null | undefined,
  b: BuilderBillingAddress | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.line1 === b.line1 &&
    (a.line2 ?? null) === (b.line2 ?? null) &&
    a.city === b.city &&
    a.province === b.province &&
    a.postalCode === b.postalCode &&
    a.country === b.country
  );
}
