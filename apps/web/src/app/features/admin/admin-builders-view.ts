import type { AbstractControl, ValidationErrors } from '@angular/forms';
import type {
  Builder,
  BuilderExportKind,
  BuilderLifecycleAction,
  BuilderOffboardingBlocker,
  BuilderPaymentMethod,
  BuilderStatus,
} from '@feasly/contracts';
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
 * Lifecycle actions the drawer offers for each status (#861). Mirrors the
 * API's allowed transitions for display only — the API stays authoritative
 * and refuses anything else with a 409. Offboarded is terminal.
 */
export const LIFECYCLE_ACTIONS_BY_STATUS: Readonly<Record<BuilderStatus, readonly BuilderLifecycleAction[]>> = {
  active: ['suspend', 'start_offboarding'],
  suspended: ['reactivate', 'start_offboarding'],
  offboarding: ['complete_offboarding', 'reactivate'],
  offboarded: [],
};

/** Copy for one lifecycle action: its button, confirm dialog and toast. */
export interface LifecycleActionView {
  /** Drawer button label. */
  readonly label: string;
  /** Dialog heading; `{name}` is the builder's business name. */
  readonly title: string;
  /** What happens, in plain words; `{name}` as above. */
  readonly body: string;
  /** Confirm button label. */
  readonly verb: string;
  readonly tone: 'danger' | 'default';
  /** Toast after it succeeds. */
  readonly done: string;
}

export const LIFECYCLE_ACTION_VIEWS: Readonly<Record<BuilderLifecycleAction, LifecycleActionView>> = {
  suspend: {
    label: 'Suspend',
    title: 'Suspend {name}?',
    body:
      '{name} gets no new leads (they go to the unassigned queue) and their estimator stops ' +
      'loading on their site. Their team can still sign in to view and pay invoices, but ' +
      'can’t change anything. Card auto-charges pause.',
    verb: 'Suspend',
    tone: 'danger',
    done: 'Builder suspended.',
  },
  reactivate: {
    label: 'Reactivate',
    title: 'Reactivate {name}?',
    body:
      '{name} gets new leads again, their estimator loads on their site, and their team can ' +
      'use the portal as before. Nothing was deleted while they were paused.',
    verb: 'Reactivate',
    tone: 'default',
    done: 'Builder reactivated.',
  },
  start_offboarding: {
    label: 'Start offboarding',
    title: 'Start offboarding {name}?',
    body:
      '{name} stops getting new leads and their estimator stops loading. Their team can still ' +
      'work existing leads and settle open invoices. Commission on leads already introduced ' +
      'still applies for 12 months.',
    verb: 'Start offboarding',
    tone: 'danger',
    done: 'Offboarding started.',
  },
  complete_offboarding: {
    label: 'Complete offboarding',
    title: 'Complete offboarding for {name}?',
    body:
      'This ends the relationship. Every team session and API key is revoked and the saved ' +
      'card is removed. Invoices and lead attribution are kept; commission on earlier leads ' +
      'is invoiced with a pay-now link.',
    verb: 'Complete offboarding',
    tone: 'danger',
    done: 'Offboarding complete.',
  },
};

/** Fill `{name}` in a lifecycle copy string. */
export function lifecycleText(template: string, name: string): string {
  return template.split('{name}').join(name);
}

/** Mandatory lifecycle reason length (mirrors the API's 3–1000). */
export const LIFECYCLE_REASON_MIN = 3;
export const LIFECYCLE_REASON_MAX = 1000;

/** Readable label for one offboarding blocker (#861 checklist). */
export function blockerLabel(blocker: BuilderOffboardingBlocker): string {
  const invoice = blocker.invoiceNumber ?? 'Invoice';
  return blocker.kind === 'open_dispute'
    ? `${invoice} — open dispute (${humanStatus(blocker.status)})`
    : `${invoice} — unpaid (${humanStatus(blocker.status)})`;
}

function humanStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

/** Export buttons (#861 hand-over export). */
export const EXPORT_KINDS: readonly { kind: BuilderExportKind; label: string }[] = [
  { kind: 'leads', label: 'Export leads (CSV)' },
  { kind: 'invoices', label: 'Export invoices (CSV)' },
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
