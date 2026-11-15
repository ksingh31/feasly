/**
 * Portal status dictionary (docs/design/portal-ui-kit.md §2).
 *
 * One map from a domain status to `{ label, tone }`, shared by every chip,
 * banner and table in the builder portal and admin console. Labels are
 * sentence case; enum values never reach the UI raw.
 *
 * Pure data + lookups — no Angular, no app state.
 */
import type {
  AdminLeadStatus,
  AdminUserStatus,
  BuilderLeadStatus,
  BuilderStatus,
  CommissionInvoiceStatus,
} from '@feasly/contracts';

/** Semantic tones; each maps to a `--status-<tone>-bg/-fg` token pair. */
export type StatusTone =
  | 'neutral'
  | 'info'
  | 'progress'
  | 'success'
  | 'warning'
  | 'danger'
  | 'paused';

export interface StatusPresentation {
  readonly label: string;
  readonly tone: StatusTone;
}

/** Lead pipeline — admin (`quoting`) and builder (`quoted`) wire values. */
export type LeadStatusKey = AdminLeadStatus | BuilderLeadStatus;
/** Portal member/user — the spec's `deactivated` plus the wire `disabled`. */
export type MemberStatusKey = AdminUserStatus | 'deactivated';
/** Builder account health — spec states plus the wire `inactive`. */
export type BuilderStatusKey = BuilderStatus | 'past_due' | 'degraded' | 'suspended';
export type ApiKeyStatusKey = 'active' | 'revoked';
/** Dispute review SLA — derive the key with {@link disputeSlaKey}. */
export type DisputeSlaKey = 'on_track' | 'due_today' | 'overdue';
/** Lead-score heat pill (builder review: Hot ≥85, Warm 65–84, Cool <65). */
export type LeadHeatKey = 'hot' | 'warm' | 'cool';

type Dictionary<K extends string> = Readonly<Record<K, StatusPresentation>>;

const LEAD: Dictionary<LeadStatusKey> = {
  new: { label: 'New', tone: 'info' },
  contacted: { label: 'Contacted', tone: 'progress' },
  quoting: { label: 'Quoting', tone: 'warning' },
  quoted: { label: 'Quoted', tone: 'warning' },
  won: { label: 'Won', tone: 'success' },
  lost: { label: 'Lost', tone: 'neutral' },
};

const INVOICE: Dictionary<CommissionInvoiceStatus> = {
  draft: { label: 'Draft', tone: 'neutral' },
  in_review: { label: 'In review', tone: 'warning' },
  finalized: { label: 'Finalized', tone: 'info' },
  paid: { label: 'Paid', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  disputed: { label: 'Disputed', tone: 'paused' },
  void: { label: 'Void', tone: 'neutral' },
};

const MEMBER: Dictionary<MemberStatusKey> = {
  active: { label: 'Active', tone: 'success' },
  invited: { label: 'Invited', tone: 'info' },
  deactivated: { label: 'Deactivated', tone: 'neutral' },
  disabled: { label: 'Deactivated', tone: 'neutral' },
};

const BUILDER: Dictionary<BuilderStatusKey> = {
  active: { label: 'Active', tone: 'success' },
  inactive: { label: 'Inactive', tone: 'neutral' },
  past_due: { label: 'Past due', tone: 'warning' },
  degraded: { label: 'Degraded', tone: 'danger' },
  suspended: { label: 'Suspended', tone: 'danger' },
};

const API_KEY: Dictionary<ApiKeyStatusKey> = {
  active: { label: 'Active', tone: 'success' },
  revoked: { label: 'Revoked', tone: 'neutral' },
};

const DISPUTE_SLA: Dictionary<DisputeSlaKey> = {
  on_track: { label: 'On track', tone: 'neutral' },
  due_today: { label: 'Due today', tone: 'warning' },
  overdue: { label: 'Overdue', tone: 'danger' },
};

const LEAD_HEAT: Dictionary<LeadHeatKey> = {
  hot: { label: 'Hot', tone: 'danger' },
  warm: { label: 'Warm', tone: 'warning' },
  cool: { label: 'Cool', tone: 'info' },
};

/** Every domain the dictionary covers, keyed by domain name. */
export const STATUS_DICTIONARY = {
  lead: LEAD,
  invoice: INVOICE,
  member: MEMBER,
  builder: BUILDER,
  apiKey: API_KEY,
  disputeSla: DISPUTE_SLA,
  leadHeat: LEAD_HEAT,
} as const;

export type StatusDomain = keyof typeof STATUS_DICTIONARY;

/**
 * Enum values whose sentence-case label is not just "underscores to spaces,
 * capitalise the first letter".
 */
const ENUM_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  e_transfer: 'E-transfer',
  api_key: 'API key',
  super_admin: 'Super admin',
};

/**
 * Sentence-case label for any wire enum value:
 * `new_build` → "New build", `e_transfer` → "E-transfer", `bank-draft` →
 * "Bank draft". Empty/nullish input renders '—'.
 */
export function enumLabel(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  if (Object.prototype.hasOwnProperty.call(ENUM_LABEL_OVERRIDES, value)) {
    return ENUM_LABEL_OVERRIDES[value];
  }
  const words = value.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Looks up a status. Unknown values (a new backend enum the client has not
 * shipped yet) fall back to a neutral chip with a humanised label — never
 * the raw enum.
 */
export function statusPresentation(
  domain: StatusDomain,
  status: string | null | undefined,
): StatusPresentation {
  const map = STATUS_DICTIONARY[domain] as Readonly<Record<string, StatusPresentation>>;
  if (status && Object.prototype.hasOwnProperty.call(map, status)) {
    return map[status];
  }
  return { label: enumLabel(status), tone: 'neutral' };
}

/**
 * Dispute SLA key from whole days left until the review deadline (e.g.
 * `edmontonDayDiff(deadline)`): ≥1 day → on track, 0 → due today,
 * negative → overdue.
 */
export function disputeSlaKey(daysLeft: number): DisputeSlaKey {
  if (daysLeft < 0) {
    return 'overdue';
  }
  return daysLeft === 0 ? 'due_today' : 'on_track';
}
