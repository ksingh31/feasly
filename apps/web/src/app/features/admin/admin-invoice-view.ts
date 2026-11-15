/**
 * Pure display helpers for the admin invoice drawer and its action
 * modals (#543, review S10/S11). No Angular, no I/O — every figure shown
 * comes from the server; the only arithmetic here is the rate-change
 * preview the old Manage modal already showed (contract × rate), which
 * the server recomputes authoritatively on save.
 */
import type {
  BillingEvent,
  BuilderPaymentMethod,
  CommissionInvoiceStatus,
  ManualPaymentMethod,
} from '@feasly/contracts';
import type { TimelineEvent } from '@app/shared/ui';
import type { BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';
import {
  MANUAL_PAYMENT_METHOD_LABELS,
  PLANNED_PAYMENT_METHOD_LABELS,
} from './admin-billing-api.service';
import { humanisePayload } from './admin-disputes-view';

/** Rate range the backend accepts for a per-invoice override (percent). */
export const INVOICE_RATE_MIN_EXCLUSIVE = 0;
export const INVOICE_RATE_MAX = 10;

/** Statuses whose amount, method, and payment can still change. */
const ACTIONABLE: ReadonlySet<CommissionInvoiceStatus> = new Set(['in_review', 'failed']);

/** True when the Change rate / Change payment method / Record payment actions apply. */
export function isInvoiceActionable(status: CommissionInvoiceStatus): boolean {
  return ACTIONABLE.has(status);
}

/** "1.5%" — trims float noise, keeps up to 4 decimals. */
export function invoiceRateLabel(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  return `${Number(rate.toFixed(4))}%`;
}

/** Rate text → percent, or null when blank, not a number, or out of range. */
export function parseInvoiceRate(raw: string | null | undefined): number | null {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= INVOICE_RATE_MIN_EXCLUSIVE || n > INVOICE_RATE_MAX) return null;
  return n;
}

/** Preview of the recalculated commission for a new rate (server recomputes on save). */
export function previewCommissionCents(contractValueCents: number, rate: number): number {
  return Math.round((contractValueCents * rate) / 100);
}

export function plannedMethodLabel(method: BuilderPaymentMethod | string): string {
  return PLANNED_PAYMENT_METHOD_LABELS.find((o) => o.value === method)?.label ?? method;
}

export function manualMethodLabel(method: ManualPaymentMethod | string): string {
  return MANUAL_PAYMENT_METHOD_LABELS.find((o) => o.value === method)?.label ?? method;
}

/** What happens to the Stripe auto-charge under a planned method. */
export function methodConsequence(method: BuilderPaymentMethod): string {
  return method === 'card'
    ? 'The Stripe auto-charge is armed and runs when the review window ends.'
    : 'The Stripe auto-charge is paused until staff records the payment.';
}

/** Readable titles for billing audit events; unknown types fall back to the timeline's sentence case. */
const EVENT_TITLES: Readonly<Record<string, string>> = {
  invoice_created: 'Invoice created',
  invoice_finalized: 'Finalized',
  invoice_paid: 'Paid',
  invoice_marked_paid: 'Payment recorded',
  invoice_charge_failed: 'Charge failed',
  charge_failed: 'Charge failed',
  invoice_disputed: 'Disputed',
  dispute_opened: 'Dispute opened',
  dispute_accepted: 'Dispute accepted',
  dispute_rejected: 'Dispute rejected',
  invoice_voided: 'Voided',
  commission_rate_overridden: 'Rate changed',
  invoice_payment_method_changed: 'Payment method changed',
};

function eventTone(type: string): TimelineEvent['tone'] {
  if (type.includes('fail')) return 'danger';
  if (type.includes('paid')) return 'success';
  if (type.includes('disput')) return 'paused';
  return 'info';
}

/**
 * Billing audit rows (the dispute's audit trail) → timeline events.
 * Payloads are humanised (money formatted, raw ids dropped — #538: ids
 * only appear in the Technical IDs section).
 */
export function auditTrailToTimeline(events: readonly BillingEvent[]): TimelineEvent[] {
  return events.map((e) => {
    const details = humanisePayload(e.payload);
    return {
      id: e.id,
      at: e.createdAt,
      type: e.eventType,
      ...(EVENT_TITLES[e.eventType] ? { title: EVENT_TITLES[e.eventType] } : {}),
      tone: eventTone(e.eventType),
      ...(details ? { payload: details } : {}),
    };
  });
}

/**
 * Lifecycle milestones from the invoice's own timestamps — the activity
 * shown when there is no dispute audit trail to draw from.
 */
export function invoiceTimeline(invoice: BuilderCommissionInvoice): TimelineEvent[] {
  const events: TimelineEvent[] = [
    { id: 'created', at: invoice.createdAt, title: 'Invoice created', tone: 'info' },
  ];
  if (invoice.finalizedAt) {
    events.push({ id: 'finalized', at: invoice.finalizedAt, title: 'Finalized', tone: 'info' });
  }
  if (invoice.paidAt) {
    events.push({
      id: 'paid',
      at: invoice.paidAt,
      title: invoice.manualPaymentMethod
        ? `Payment recorded (${manualMethodLabel(invoice.manualPaymentMethod)})`
        : 'Paid',
      tone: 'success',
    });
  }
  return events;
}
