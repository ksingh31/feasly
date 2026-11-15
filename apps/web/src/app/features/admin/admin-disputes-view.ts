/**
 * Admin Disputes view helpers (#545, admin review S12) — pure display
 * mapping, no Angular, no state.
 *
 * Everything here formats server fields for display: the SLA countdown is
 * the server's `businessDaysRemaining` / `breached`, the evidence is the
 * immutable snapshot, and the timeline is the server's billing audit rows.
 * Nothing is computed beyond labels.
 */
import type {
  BillingEvent,
  DisputeDetailResponse,
  DisputeEvidenceSnapshot,
  DisputeListItem,
} from '@feasly/contracts';
import {
  type DisputeSlaKey,
  type KeyValueItem,
  type StatusTone,
  type TechnicalId,
  type TimelineEvent,
  type UiConfirmOptions,
  disputeSlaKey,
  enumLabel,
} from '@app/shared/ui';
import { formatEdmontonDateTime } from '../../shared/utils/edmonton';
import { formatCentsToCad, formatRatePercent } from '../../shared/utils/money';

/** Fallback when a pre-billing/08 snapshot has no captured rate. */
const DEFAULT_RATE_PERCENT = 1;

/** SLA chip: dictionary key (tone) + the countdown label. */
export interface DisputeSlaChip {
  readonly key: DisputeSlaKey;
  readonly label: string;
}

/**
 * "4 days left" (neutral) · "Due today" (warning) · "Overdue 1d" (danger),
 * from the server's business-day countdown. `breached` wins so a dispute
 * the server already escalated never reads as on track.
 */
export function disputeSlaChip(item: Pick<DisputeListItem, 'businessDaysRemaining' | 'breached'>): DisputeSlaChip {
  const remaining = item.businessDaysRemaining;
  const key: DisputeSlaKey = item.breached ? 'overdue' : disputeSlaKey(remaining);
  if (key === 'overdue') {
    const overdue = Math.max(1, Math.abs(Math.min(remaining, 0)));
    return { key, label: `Overdue ${overdue}d` };
  }
  if (key === 'due_today') {
    return { key, label: 'Due today' };
  }
  return { key, label: remaining === 1 ? '1 day left' : `${remaining} days left` };
}

/** Evidence snapshot as a definition list (formatted, never raw cents). */
export function disputeEvidenceItems(s: DisputeEvidenceSnapshot): KeyValueItem[] {
  const rate = formatRatePercent(s.effectiveRatePercent ?? DEFAULT_RATE_PERCENT);
  return [
    { label: 'Dispute reason', value: s.disputeReason },
    { label: 'Contract value (excl. land)', value: formatCentsToCad(s.contractValueCents) },
    { label: `Commission (${rate})`, value: formatCentsToCad(s.commissionCents) },
    { label: 'Currency', value: s.currency },
    { label: 'Invoice created', value: formatEdmontonDateTime(s.invoiceCreatedAt) },
    { label: 'Disputed at', value: formatEdmontonDateTime(s.disputedAt) },
    { label: 'Review window ended', value: formatEdmontonDateTime(s.reviewDueAt) },
    { label: 'Builder', value: s.tenantKey },
  ];
}

/**
 * Raw identifiers for the collapsed "Technical IDs" section (#538,
 * portal-ui-kit §5: no raw UUIDs anywhere else). Payment intent only when
 * the invoice was charged.
 */
export function disputeTechnicalIds(d: DisputeDetailResponse): TechnicalId[] {
  const s = d.evidenceSnapshot;
  const ids: TechnicalId[] = [
    { label: 'Dispute ID', value: d.id },
    { label: 'Invoice ID', value: d.invoiceId },
    { label: 'Lead ID', value: s.leadId },
    { label: 'Attribution ID', value: s.attributionId },
  ];
  if (s.stripePaymentIntentId) ids.push({ label: 'Payment intent', value: s.stripePaymentIntentId });
  return ids;
}

/** Audit event titles; unknown types fall back to the sentence-cased type. */
const EVENT_TITLES: Readonly<Record<string, string>> = {
  'invoice.created': 'Invoice created',
  'invoice.status_changed': 'Invoice status changed',
  'invoice.commission_rate_changed': 'Commission rate changed',
  'invoice.payment_succeeded': 'Payment succeeded',
  'invoice.payment_failed': 'Payment failed',
  'invoice.charge_failed': 'Charge failed',
  'invoice.charge_blocked_disputed': 'Charge held (disputed)',
  'invoice.payment_method_changed': 'Payment method changed',
  'dispute.opened': 'Dispute opened',
  'dispute.resolved': 'Dispute resolved',
  'dispute.sla_breached': 'Dispute SLA breached',
};

const EVENT_TONES: Readonly<Record<string, StatusTone>> = {
  'invoice.payment_succeeded': 'success',
  'invoice.payment_failed': 'danger',
  'invoice.charge_failed': 'danger',
  'invoice.charge_blocked_disputed': 'paused',
  'dispute.opened': 'warning',
  'dispute.resolved': 'success',
  'dispute.sla_breached': 'danger',
};

type FieldKind = 'money' | 'rate' | 'date' | 'enum' | 'text' | 'bool';

/** Payload keys → label + how to format the value. */
const PAYLOAD_FIELDS: Readonly<Record<string, readonly [string, FieldKind]>> = {
  contractValueCents: ['Contract value', 'money'],
  commissionCents: ['Commission', 'money'],
  oldCommissionCents: ['Previous commission', 'money'],
  newCommissionCents: ['New commission', 'money'],
  commissionRatePercent: ['Commission rate', 'rate'],
  fromRatePercent: ['Previous rate', 'rate'],
  toRatePercent: ['New rate', 'rate'],
  status: ['Status', 'enum'],
  from: ['From', 'enum'],
  to: ['To', 'enum'],
  outcome: ['Outcome', 'enum'],
  resolution: ['Resolution', 'enum'],
  creditNote: ['Credit note', 'enum'],
  paymentMethod: ['Payment method', 'enum'],
  kind: ['Kind', 'enum'],
  reason: ['Reason', 'text'],
  disputeReason: ['Reason', 'text'],
  note: ['Note', 'text'],
  resolvedBy: ['Resolved by', 'text'],
  adminEmail: ['By', 'text'],
  invoiceNumber: ['Invoice', 'text'],
  slaDueAt: ['SLA due', 'date'],
  attempted: ['Charge attempted', 'bool'],
  slaBreached: ['Late report', 'bool'],
  autoResolved: ['Auto-resolved', 'bool'],
  backfilled: ['Backfilled', 'bool'],
};

/**
 * Raw identifier keys never rendered in the timeline (#538): they live in
 * the drawer's Technical IDs section instead.
 */
const HIDDEN_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'invoiceId',
  'disputeId',
  'leadId',
  'attributionId',
  'refundId',
  'stripePaymentIntentId',
  'paymentIntentId',
]);

function formatField(kind: FieldKind, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (kind) {
    case 'money':
      return typeof value === 'number' ? formatCentsToCad(value) : String(value);
    case 'rate':
      return typeof value === 'number' ? formatRatePercent(value) : String(value);
    case 'date':
      return typeof value === 'string' ? formatEdmontonDateTime(value) : String(value);
    case 'enum':
      return typeof value === 'string' ? enumLabel(value) : String(value);
    case 'bool':
      return value === true ? 'Yes' : value === false ? 'No' : String(value);
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/**
 * Payload → readable lines ("Contract value $980,000"). Unknown keys get a
 * sentence-cased label; values are never shown as raw JSON at top level.
 */
export function humanisePayload(payload: Record<string, unknown> | null): string {
  if (!payload) return '';
  return Object.entries(payload)
    .filter(([key]) => !HIDDEN_PAYLOAD_KEYS.has(key))
    .map(([key, value]) => {
      const field = PAYLOAD_FIELDS[key];
      const label = field ? field[0] : enumLabel(key.replace(/([a-z])([A-Z])/g, '$1_$2'));
      return `${label} ${formatField(field ? field[1] : 'text', value)}`;
    })
    .join('\n');
}

function eventTitle(event: BillingEvent): string {
  const base = EVENT_TITLES[event.eventType] ?? enumLabel(event.eventType.replace(/\./g, '_'));
  const payload = event.payload ?? {};
  if (event.eventType === 'invoice.status_changed' && typeof payload['status'] === 'string') {
    return `Invoice ${enumLabel(payload['status']).toLowerCase()}`;
  }
  if (event.eventType === 'dispute.resolved' && typeof payload['outcome'] === 'string') {
    return `Dispute ${payload['outcome']}`;
  }
  return base;
}

function eventActor(event: BillingEvent): string | undefined {
  const payload = event.payload ?? {};
  const actor = payload['resolvedBy'] ?? payload['adminEmail'];
  return typeof actor === 'string' && actor ? actor : undefined;
}

/** Audit trail → kit Timeline events with humanised titles and details. */
export function disputeTimeline(events: readonly BillingEvent[]): TimelineEvent[] {
  return events.map((event) => {
    const details = humanisePayload(event.payload);
    return {
      id: event.id,
      at: event.createdAt,
      type: event.eventType,
      title: eventTitle(event),
      actor: eventActor(event),
      tone: EVENT_TONES[event.eventType] ?? 'neutral',
      ...(details ? { payload: details } : {}),
    };
  });
}

/**
 * Accept confirm (AC2): names the void and the refund amount. The refund
 * applies only when the invoice was already charged — the server decides.
 */
export function acceptConfirmOptions(d: DisputeDetailResponse): UiConfirmOptions {
  const amount = formatCentsToCad(d.commissionCents);
  return {
    title: `Accept dispute and void the ${d.tenantKey} invoice?`,
    body:
      `Accepting voids this ${amount} commission invoice for ${d.tenantKey}. ` +
      `If it was already charged, ${amount} is refunded to the card first. ` +
      'This is recorded in the audit trail.',
    verb: 'Accept and void',
    cancelLabel: 'Cancel',
    tone: 'danger',
  };
}

/** Reject confirm: the invoice goes back to review with a fresh window. */
export function rejectConfirmOptions(d: DisputeDetailResponse): UiConfirmOptions {
  return {
    title: `Reject dispute on the ${d.tenantKey} invoice?`,
    body:
      `The ${formatCentsToCad(d.commissionCents)} invoice for ${d.tenantKey} goes back to review ` +
      'with a fresh 7-day window. This is recorded in the audit trail.',
    verb: 'Reject dispute',
    cancelLabel: 'Cancel',
    tone: 'default',
  };
}
