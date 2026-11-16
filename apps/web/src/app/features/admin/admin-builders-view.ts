import type { AbstractControl, ValidationErrors } from '@angular/forms';
import type { Builder, BuilderPaymentMethod, BuilderStatus } from '@feasly/contracts';
import { isBuilderPaymentMethod } from '../builder/builder-payment-methods';

/**
 * Admin Builders view helpers (#541) shared by the table page and the
 * builder drawer. Display formatting only — no business rules: the rate
 * range, tenant-key and colour shapes mirror the backend zod schema.
 */

/** Tenant-key shape enforced by the backend (lowercase alphanumeric with dashes). */
export const TENANT_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Backend accent-color shape (#rrggbb hex). */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Builder plan options — '' = undecided (stored as null). */
export const PLAN_OPTIONS = [
  { value: '', label: 'Undecided' },
  { value: 'flat', label: 'Flat — monthly fee' },
  { value: 'commission', label: 'Commission — share of signed builds' },
] as const;

/** Short plan labels for the narrow table column (S7). */
const PLAN_SHORT: Readonly<Record<string, string>> = {
  flat: 'Flat',
  commission: 'Commission',
};

/** Short payment-method labels for the table column (S7: "Card auto", "E-transfer"). */
const METHOD_SHORT: Readonly<Record<BuilderPaymentMethod, string>> = {
  card: 'Card auto',
  cheque: 'Cheque',
  e_transfer: 'E-transfer',
  bank_draft: 'Bank draft',
};

/**
 * #860: status changes now go through the lifecycle endpoint with a reason
 * (confirm dialogs land in #861); the drawer shows the current status.
 */
export const STATUS_OPTIONS: readonly { value: BuilderStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'offboarding', label: 'Offboarding' },
  { value: 'offboarded', label: 'Offboarded' },
];

/** Default payment method for new invoices (billing/12), stored on settings. */
export function readBuilderDefaultPaymentMethod(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): BuilderPaymentMethod {
  const raw = settings?.['defaultPaymentMethod'];
  return isBuilderPaymentMethod(raw) ? raw : 'card';
}

export function planShortLabel(plan: string | null): string {
  return (plan && PLAN_SHORT[plan]) || 'Undecided';
}

export function methodShortLabel(builder: Pick<Builder, 'settings'>): string {
  return METHOD_SHORT[readBuilderDefaultPaymentMethod(builder.settings)];
}

/**
 * Commission rate as a percent label, e.g. "1%" / "1.25%". The contract
 * guarantees the field; a missing value (stale cache) renders as the 1%
 * default. Display rounding only — never used for a charge.
 */
export function rateLabel(ratePercent: number | null | undefined): string {
  const rounded = Math.round((ratePercent ?? 1) * 10_000) / 10_000;
  return `${Number(rounded.toFixed(4))}%`;
}

/** Valid JSON object (or empty) for the Advanced settings field. */
export function jsonObjectValidator(control: AbstractControl): ValidationErrors | null {
  const raw = String(control.value ?? '').trim();
  if (raw.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { jsonObject: true };
    }
    return null;
  } catch {
    return { jsonInvalid: true };
  }
}

/** Settings JSON for the Advanced textarea ('' when empty). */
export function settingsText(settings: Readonly<Record<string, unknown>>): string {
  return Object.keys(settings).length > 0 ? JSON.stringify(settings, null, 2) : '';
}

/** Allowed-origins textarea → trimmed, non-empty lines. */
export function parseOrigins(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function nullIfBlank(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length === 0 ? null : trimmed;
}
