/**
 * #881: builder billing-address form helpers, shared by the admin builder
 * drawer and the builder portal Settings page. Shape checks only — the
 * backend validates and normalizes (lib/billing-address.ts); these mirror
 * its CA rules so the form can explain a problem before the round trip.
 */
import type { DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  Validators,
  type AbstractControl,
  type FormGroup,
  type ValidationErrors,
  type ValidatorFn,
} from '@angular/forms';
import type { BuilderBillingAddress, BuilderBillingAddressInput } from '@feasly/contracts';

function nullIfBlank(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * #881: Canadian province/territory options for the billing address (the
 * backend accepts exactly these codes for a CA address).
 */
export const CA_PROVINCE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'AB', label: 'Alberta' },
  { value: 'BC', label: 'British Columbia' },
  { value: 'MB', label: 'Manitoba' },
  { value: 'NB', label: 'New Brunswick' },
  { value: 'NL', label: 'Newfoundland and Labrador' },
  { value: 'NS', label: 'Nova Scotia' },
  { value: 'NT', label: 'Northwest Territories' },
  { value: 'NU', label: 'Nunavut' },
  { value: 'ON', label: 'Ontario' },
  { value: 'PE', label: 'Prince Edward Island' },
  { value: 'QC', label: 'Quebec' },
  { value: 'SK', label: 'Saskatchewan' },
  { value: 'YT', label: 'Yukon' },
];

/** #881: mirrors the backend's Canadian postal-code shape (it normalizes). */
export const CA_POSTAL_RE =
  /^\s*[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z][ -]?[0-9][ABCEGHJ-NPRSTV-Z][0-9]\s*$/i;

/** #881: the billing-address form fields (flat, all strings). */
export interface BillingAddressFields {
  readonly billingLine1: string;
  readonly billingLine2: string;
  readonly billingCity: string;
  readonly billingProvince: string | null;
  readonly billingPostalCode: string;
}

/** Saved address → form fields ('' / null when not set). */
export function billingAddressFields(
  address: BuilderBillingAddress | null | undefined,
): BillingAddressFields {
  return {
    billingLine1: address?.line1 ?? '',
    billingLine2: address?.line2 ?? '',
    billingCity: address?.city ?? '',
    billingProvince: address?.province ?? null,
    billingPostalCode: address?.postalCode ?? '',
  };
}

/** The billing-address control names, in form order. */
export const BILLING_ADDRESS_FIELD_NAMES = [
  'billingLine1',
  'billingLine2',
  'billingCity',
  'billingProvince',
  'billingPostalCode',
] as const satisfies readonly (keyof BillingAddressFields)[];

/** True when any billing-address field holds a value. */
export function billingAddressStarted(v: Partial<BillingAddressFields>): boolean {
  return [v.billingLine1, v.billingLine2, v.billingCity, v.billingProvince, v.billingPostalCode].some(
    (f) => (f ?? '').trim().length > 0,
  );
}

/**
 * Form fields → request body. All blank = null (no address / clear it);
 * the backend validates and normalizes (country defaults to CA).
 */
export function billingAddressInput(v: BillingAddressFields): BuilderBillingAddressInput | null {
  if (!billingAddressStarted(v)) return null;
  return {
    line1: v.billingLine1.trim(),
    line2: nullIfBlank(v.billingLine2),
    city: v.billingCity.trim(),
    province: v.billingProvince ?? '',
    postalCode: v.billingPostalCode.trim(),
    country: 'CA',
  };
}

/**
 * #881: required once any address field is filled (a partial address
 * can't be sent). Reads siblings from the parent group.
 */
export function requiredWhenAddressStarted(control: AbstractControl): ValidationErrors | null {
  const parent = control.parent;
  if (!parent) return null;
  // Read each sibling control: `parent.value` is stale while a control is
  // validating its own new value.
  const fields: Partial<Record<keyof BillingAddressFields, string | null>> = {};
  for (const name of BILLING_ADDRESS_FIELD_NAMES) {
    fields[name] = (parent.get(name)?.value as string | null | undefined) ?? null;
  }
  if (!billingAddressStarted(fields as Partial<BillingAddressFields>)) return null;
  return String(control.value ?? '').trim().length === 0 ? { required: true } : null;
}

/**
 * Re-check the sibling address fields whenever one changes ("required once
 * started" depends on all of them). Stops with `destroyRef`.
 */
export function watchBillingAddressValidity(group: FormGroup, destroyRef: DestroyRef): void {
  for (const name of BILLING_ADDRESS_FIELD_NAMES) {
    group
      .get(name)
      ?.valueChanges.pipe(takeUntilDestroyed(destroyRef))
      .subscribe(() => {
        for (const other of BILLING_ADDRESS_FIELD_NAMES) {
          if (other !== name) group.get(other)?.updateValueAndValidity({ emitEvent: false });
        }
      });
  }
}

/** Backend limits (apps/api/src/lib/billing-address.ts zod schema). */
const LINE_MAX_LENGTH = 200;
const CITY_MAX_LENGTH = 100;

/** #881: validators per billing-address control, shared by both forms. */
export const BILLING_ADDRESS_VALIDATORS: Readonly<Record<keyof BillingAddressFields, ValidatorFn[]>> = {
  billingLine1: [requiredWhenAddressStarted, Validators.maxLength(LINE_MAX_LENGTH)],
  billingLine2: [Validators.maxLength(LINE_MAX_LENGTH)],
  billingCity: [requiredWhenAddressStarted, Validators.maxLength(CITY_MAX_LENGTH)],
  billingProvince: [requiredWhenAddressStarted],
  billingPostalCode: [requiredWhenAddressStarted, Validators.pattern(CA_POSTAL_RE)],
};
