/**
 * Pure display helpers for the admin invoice drawer and its action
 * modals (#543, review S10/S11). No Angular, no I/O — every figure shown
 * comes from the server; the only arithmetic here is the rate-change
 * preview the old Manage modal already showed (contract × rate), which
 * the server recomputes authoritatively on save — and the #862 refund
 * preview (refunded + amount, total − refunded), integer cents only.
 */
import type {
  AuditLogEntry,
  BillingEvent,
  BuilderPaymentMethod,
  CommissionInvoiceStatus,
  InvoiceRefundMethod,
  InvoiceRefundReason,
  ManualPaymentMethod,
  VoidInvoiceReason,
} from '@feasly/contracts';
import { enumLabel, type TimelineEvent } from '@app/shared/ui';
import { formatCentsToCad } from '../../shared/utils/money';
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

/*
 * #862 (#715 API): which adjustment actions apply. Each mirrors the
 * server's precondition so the drawer never offers an action the API
 * would answer with 409.
 */
const VOIDABLE: ReadonlySet<CommissionInvoiceStatus> = new Set(['draft', 'in_review', 'failed']);
const CORRECTABLE: ReadonlySet<CommissionInvoiceStatus> = new Set(['draft', 'in_review']);

/** The invoice fields the adjustment rules read. */
export type InvoiceAdjustmentFields = Pick<
  BuilderCommissionInvoice,
  'status' | 'totalCents' | 'refundedCents' | 'manualPaymentMethod' | 'stripePaymentIntentId'
>;

/** Total still refundable, integer cents (server figures; never below 0). */
export function refundableCents(invoice: Pick<BuilderCommissionInvoice, 'totalCents' | 'refundedCents'>): number {
  return Math.max(0, invoice.totalCents - (invoice.refundedCents ?? 0));
}

/** Refund…: a paid invoice with something left to refund. */
export function canRefundInvoice(invoice: InvoiceAdjustmentFields): boolean {
  return invoice.status === 'paid' && refundableCents(invoice) > 0;
}

/** Void…: draft, in review or failed (finalized / paid / disputed / void get 409). */
export function canVoidInvoice(invoice: Pick<BuilderCommissionInvoice, 'status'>): boolean {
  return VOIDABLE.has(invoice.status);
}

/** Correct contract…: before the invoice is charged (draft, in review). */
export function canCorrectContract(invoice: Pick<BuilderCommissionInvoice, 'status'>): boolean {
  return CORRECTABLE.has(invoice.status);
}

/** Reverse payment…: paid by hand, with no refunds recorded. */
export function canReversePayment(invoice: InvoiceAdjustmentFields): boolean {
  return invoice.status === 'paid' && invoice.manualPaymentMethod !== null && (invoice.refundedCents ?? 0) === 0;
}

/**
 * A refund of an invoice paid off-Stripe (or with no card charge) is
 * recorded by hand and needs its cheque / trace reference — the same
 * rule the API applies.
 */
export function refundNeedsReference(invoice: InvoiceAdjustmentFields): boolean {
  return invoice.manualPaymentMethod !== null || invoice.stripePaymentIntentId === null;
}

/** Refund before → after for the confirm modal (preview; the server decides). */
export interface RefundPreview {
  readonly refundedBefore: number;
  readonly refundedAfter: number;
  readonly netBefore: number;
  readonly netAfter: number;
}

/** Null when the amount is not a positive whole number of cents within what is left. */
export function refundPreview(
  invoice: Pick<BuilderCommissionInvoice, 'totalCents' | 'refundedCents'>,
  amountCents: number | null,
): RefundPreview | null {
  const left = refundableCents(invoice);
  if (amountCents === null || !Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > left) {
    return null;
  }
  const refundedBefore = invoice.refundedCents ?? 0;
  return {
    refundedBefore,
    refundedAfter: refundedBefore + amountCents,
    netBefore: invoice.totalCents - refundedBefore,
    netAfter: invoice.totalCents - refundedBefore - amountCents,
  };
}

/** Integer cents → the "1234.50" text a refund amount field starts with. */
export function centsToDollarInput(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}

/** Longest note / reason the #715 endpoints accept. */
export const ADJUSTMENT_NOTE_MAX = 500;
/** Longest cheque / trace reference the refund endpoint accepts. */
export const REFUND_REFERENCE_MAX = 120;

/** One idempotency key per refund intent (`[A-Za-z0-9_:-]{8,100}`). */
export function newRefundIdempotencyKey(): string {
  return `refund-${globalThis.crypto.randomUUID()}`;
}

/**
 * True when a refund failure is a definite rejection made before the
 * server claimed the idempotency key (#715 `refundInvoice`: 400 validation,
 * 422 amount / reference rules). Any other failure may have claimed the
 * key, so the modal must not let the admin change what it refunds.
 */
export function refundRejectedBeforeClaim(status: number | null): boolean {
  return status === 400 || status === 422;
}

export const REFUND_REASON_LABELS: ReadonlyArray<{ value: InvoiceRefundReason; label: string }> = [
  { value: 'duplicate', label: 'Duplicate charge' },
  { value: 'billing_error', label: 'Billing error' },
  { value: 'deal_fell_through', label: 'Deal fell through' },
  { value: 'goodwill', label: 'Goodwill' },
  { value: 'other', label: 'Other' },
];

export const VOID_REASON_LABELS: ReadonlyArray<{ value: VoidInvoiceReason; label: string }> = [
  { value: 'duplicate', label: 'Duplicate invoice' },
  { value: 'created_in_error', label: 'Created in error' },
  { value: 'deal_fell_through', label: 'Deal fell through' },
  { value: 'other', label: 'Other' },
];

const REFUND_METHOD_LABELS: Readonly<Record<InvoiceRefundMethod, string>> = {
  stripe: 'Card refund (Stripe)',
  manual: 'Recorded by hand',
};

export function refundReasonLabel(reason: string): string {
  return REFUND_REASON_LABELS.find((o) => o.value === reason)?.label ?? enumLabel(reason);
}

export function voidReasonLabel(reason: string): string {
  return VOID_REASON_LABELS.find((o) => o.value === reason)?.label ?? enumLabel(reason);
}

export function refundMethodLabel(method: string): string {
  return REFUND_METHOD_LABELS[method as InvoiceRefundMethod] ?? enumLabel(method);
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
  // #719/#872: Stripe refunds + bank chargebacks.
  'invoice.refunded': 'Refunded',
  'invoice.chargeback_opened': 'Chargeback opened',
  'invoice.chargeback_closed': 'Chargeback closed',
  // #862 (#715): admin adjustments.
  'invoice.voided': 'Voided',
  'invoice.contract_corrected': 'Contract corrected',
  'invoice.payment_reversed': 'Payment reversed',
};

function eventTone(type: string): TimelineEvent['tone'] {
  if (type === 'invoice.chargeback_opened' || type === 'invoice.payment_reversed') return 'danger';
  if (type === 'invoice.voided') return 'neutral';
  if (type === 'invoice.chargeback_closed') return 'neutral';
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

/** #862: the adjustment events the admin timeline adds from the audit log. */
export const INVOICE_ADJUSTMENT_EVENTS: ReadonlySet<string> = new Set([
  'invoice.refunded',
  'invoice.voided',
  'invoice.contract_corrected',
  'invoice.payment_reversed',
]);

type Payload = Readonly<Record<string, unknown>>;

function money(value: unknown): string | null {
  return typeof value === 'number' ? formatCentsToCad(value) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function nested(payload: Payload, key: string): Payload {
  const value = payload[key];
  return typeof value === 'object' && value !== null ? (value as Payload) : {};
}

/** Readable detail lines for one adjustment event — no raw ids, no JSON. */
function adjustmentDetails(action: string, p: Payload): string {
  const lines: Array<[string, string | null]> = [];
  switch (action) {
    case 'invoice.refunded':
      lines.push(
        ['Amount', money(p['amountCents'])],
        ['Refunded in total', money(p['refundedCents'])],
        ['Method', text(p['method']) && refundMethodLabel(p['method'] as string)],
        ['Reason', text(p['reason']) && refundReasonLabel(p['reason'] as string)],
        ['Reference', text(p['reference'])],
      );
      break;
    case 'invoice.voided':
      lines.push(
        ['From', text(p['from']) && enumLabel(p['from'] as string)],
        ['Reason', text(p['reason']) && voidReasonLabel(p['reason'] as string)],
      );
      break;
    case 'invoice.contract_corrected': {
      const before = nested(p, 'old');
      const after = nested(p, 'new');
      lines.push(
        ['Previous contract value', money(before['contractValueCents'])],
        ['New contract value', money(after['contractValueCents'])],
        ['Previous total', money(before['totalCents'])],
        ['New total', money(after['totalCents'])],
      );
      break;
    }
    case 'invoice.payment_reversed':
      lines.push(
        ['Reversed method', text(p['reversedPaymentMethod']) && manualMethodLabel(p['reversedPaymentMethod'] as string)],
        ['Reversed reference', text(p['reversedReference'])],
        ['Reason', text(p['reason'])],
      );
      break;
  }
  lines.push(['Note', text(p['note'])]);
  return lines
    .filter((line): line is [string, string] => line[1] !== null && line[1] !== '')
    .map(([label, value]) => `${label} ${value}`)
    .join('\n');
}

/** Billing audit ids are `billing:<uuid>`; the dispute trail uses the bare uuid. */
function bareId(id: string): string {
  return id.startsWith('billing:') ? id.slice('billing:'.length) : id;
}

/**
 * #862: refund / void / contract-correction / payment-reversal entries
 * from the invoice's audit log → timeline events. Other actions are left
 * to the base timeline (milestones or the dispute trail).
 */
export function adjustmentTimeline(entries: readonly AuditLogEntry[]): TimelineEvent[] {
  return entries
    .filter((e) => INVOICE_ADJUSTMENT_EVENTS.has(e.action))
    .map((e) => {
      const details = adjustmentDetails(e.action, e.payload ?? {});
      return {
        id: bareId(e.id),
        at: e.occurredAt,
        type: e.action,
        title: EVENT_TITLES[e.action] ?? enumLabel(e.action.replace(/\./g, '_')),
        ...(e.actorEmail ? { actor: e.actorEmail } : {}),
        tone: eventTone(e.action),
        ...(details ? { payload: details } : {}),
      };
    });
}

/** Base timeline + adjustment events, without repeating an event both carry. */
export function mergeTimelines(base: readonly TimelineEvent[], extra: readonly TimelineEvent[]): TimelineEvent[] {
  const seen = new Set(base.map((e) => e.id));
  return [...base, ...extra.filter((e) => !seen.has(e.id))];
}
