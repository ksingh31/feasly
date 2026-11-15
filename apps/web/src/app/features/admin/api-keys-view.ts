import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import type { ApiKeyRecordResponse, ApiKeyScope, Builder } from '@feasly/contracts';
import type { EntityOption } from '@app/shared/ui';
import type { ApiKeyUsageAggregate } from '../../core/api/api.service';

/**
 * Admin API keys view helpers (#546, review S13), shared by the table page,
 * the key drawer, the issue modal and the usage panel. Display shaping
 * only: the rate-limit range mirrors the backend zod schema.
 */

export type ApiKeyStatus = 'active' | 'revoked';

export function apiKeyStatus(key: Pick<ApiKeyRecordResponse, 'revoked_at'>): ApiKeyStatus {
  return key.revoked_at ? 'revoked' : 'active';
}

/** Builder picker options: the value is the builder's tenant key (the key's `tenant_id`). */
export function builderOptions(builders: readonly Builder[]): EntityOption[] {
  return builders.map((b) => ({ id: b.tenantKey, label: b.displayName, meta: b.tenantKey }));
}

/** Builder display name for a key's tenant binding; the raw key when no builder matches; null when unbound. */
export function builderName(tenantId: string | null, builders: readonly Builder[]): string | null {
  if (!tenantId) return null;
  return builders.find((b) => b.tenantKey === tenantId)?.displayName ?? tenantId;
}

/** Rate-limit text → whole number, or null when blank / not an integer. */
export function parseRateLimit(raw: string | null | undefined): number | null {
  const trimmed = (raw ?? '').trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** Whole number from 1 to `max` (the API rejects anything else). */
export function rateLimitValidator(max: number): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const n = parseRateLimit(String(control.value ?? ''));
    return n === null || n < 1 || n > max ? { rateLimit: true } : null;
  };
}

/** At least one scope picked. */
export function scopesValidator(control: AbstractControl): ValidationErrors | null {
  const value = control.value as readonly ApiKeyScope[] | null;
  return value && value.length > 0 ? null : { scopes: true };
}

/** One bar in the per-day usage chart. */
export interface UsageDay {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** "Nov 12" (tooltip + screen readers). */
  readonly label: string;
  /** Day of the month under the bar, e.g. "12". */
  readonly tick: string;
  readonly count: number;
  /** Bar height as a share of the busiest day, 0–1. */
  readonly share: number;
}

const DAY_LABEL = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** `YYYY-MM-DD` → "Nov 12" (the date is a calendar day, so format it in UTC). */
export function dayLabel(date: string): string {
  // A bare `YYYY-MM-DD` parses as UTC midnight.
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date) : new Date(Number.NaN);
  return Number.isNaN(parsed.getTime()) ? date : DAY_LABEL.format(parsed);
}

/** Sums the per-endpoint rows into one bar per day, oldest first. */
export function usageByDay(rows: readonly ApiKeyUsageAggregate[]): UsageDay[] {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.date, (totals.get(row.date) ?? 0) + row.count);
  const days = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
  const peak = Math.max(0, ...days.map(([, count]) => count));
  return days.map(([date, count]) => ({
    date,
    label: dayLabel(date),
    tick: String(Number(date.slice(date.lastIndexOf('-') + 1)) || date),
    count,
    share: peak > 0 ? count / peak : 0,
  }));
}

/** Fills `{name}`-style placeholders. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
