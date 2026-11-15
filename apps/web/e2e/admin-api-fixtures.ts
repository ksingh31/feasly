/**
 * #548: contract-shaped API fixtures for the admin console e2e.
 *
 * Every admin endpoint the console reads is answered here via Playwright
 * request interception, so the suite runs against the static production
 * build with no Functions host, database or Entra tenant. Shapes are typed
 * against `@feasly/contracts` (and the web's own wire types where the
 * contract lives in the client) so a contract change breaks the e2e
 * typecheck (`npm run lint` → `tsc -p e2e/tsconfig.json`) instead of
 * silently drifting.
 *
 * The data deliberately carries long names / emails / addresses / keys:
 * the overflow check is only meaningful when content pushes against the
 * column widths. All dollar figures are fixture integers standing in for
 * server-computed values — the client never computes them.
 */
import type { Page, Route } from '@playwright/test';
import type {
  AdminAuthMeResponse,
  AdminBuilderDetail,
  AdminCalibrationResponse,
  AdminEstimateDetail,
  AdminLeadDetail,
  AdminLeadListItem,
  AdminLeadListResponse,
  AdminSearchResponse,
  AdminUser,
  AdminUserListResponse,
  ApiKeyListResponse,
  ApiKeyRecordResponse,
  BillingHealthResponse,
  Builder,
  BuilderListResponse,
  CommentListResponse,
  DisputeDetailResponse,
  DisputeListItem,
  DisputeListResponse,
  SheetsSyncStatusResponse,
} from '@feasly/contracts';
import type { ApiKeyUsageAggregate } from '../src/app/core/api/api.service';
import type { FunnelReport } from '../src/app/core/api/funnel.types';
import { INVOICES } from './builder-api-fixtures';

/** Fixture timestamps are relative to now so SLA / "N days ago" copy stays stable. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
function daysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

const ELITE = 'elite-craft-builders';
const NORTHERN = 'northern-lights-custom-homes';

export const ADMIN_ME: AdminAuthMeResponse = {
  authenticated: true,
  email: 'operations.administrator@feasly-internal-staff.example',
  authContext: {
    userId: 'admin-1',
    name: 'Operations Administrator',
    staffRole: 'super_admin',
    permissions: [
      'leads:manage',
      'leads:assign',
      'builders:manage',
      'billing:read',
      'billing:manage',
      'api_keys:manage',
      'users:manage',
    ],
    builderId: null,
    builderName: null,
    memberships: [],
    viewAs: null,
    realUser: null,
  },
};

// ── Leads ────────────────────────────────────────────────────────────────

const LONG_ADDRESS = 'LAKEVIEW RIDGE CRESCENT SOUTHWEST';

function adminLead(
  n: number,
  name: string,
  status: AdminLeadListItem['status'],
  extra: Partial<AdminLeadListItem> = {},
): AdminLeadListItem {
  return {
    id: `lead-${n}`,
    name,
    email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example-mail-provider.ca`,
    addressKey: `${12340 + n} ${LONG_ADDRESS}`,
    leadScore: 92 - n * 6,
    status,
    source: n % 2 === 0 ? 'web' : 'embed',
    projectType: n % 3 === 0 ? 'renovation' : 'new_build',
    tenantKey: n % 2 === 0 ? null : ELITE,
    timeline: '6-12 months',
    sandbox: false,
    quarantined: false,
    contactConsent: n % 4 === 0 ? 'out' : 'in',
    consentUpdatedAt: daysAgo(n + 2),
    discarded: false,
    createdAt: daysAgo(n + 2),
    ...extra,
  };
}

export const ADMIN_LEADS: readonly AdminLeadListItem[] = [
  adminLead(1, 'Bartholomew & Genevieve Okonkwo-Hargreaves', 'new'),
  adminLead(2, 'Priya Ramanathan-Castellanos', 'contacted'),
  adminLead(3, 'Jordan Lee', 'quoting'),
  adminLead(4, 'Maximilian Featherstonehaugh', 'won'),
  adminLead(5, 'Sam Wu', 'lost'),
  adminLead(6, 'Christopher Vandenberghe-Lindqvist', 'new', { sandbox: true }),
];

export const ADMIN_LEAD_LIST: AdminLeadListResponse = {
  leads: ADMIN_LEADS,
  nextCursor: null,
  totalCount: ADMIN_LEADS.length,
  statusCounts: { new: 2, contacted: 1, quoting: 1, won: 1, lost: 1 },
};

/** Honeypot-flagged leads for the Quarantine page (`quarantinedOnly=true`). */
const QUARANTINED: readonly AdminLeadListItem[] = [
  adminLead(7, 'Zzzz Automated Submission With An Extremely Long Display Name', 'new', { quarantined: true }),
  adminLead(8, 'Test Test', 'new', { quarantined: true, sandbox: true }),
];

export const QUARANTINE_LIST: AdminLeadListResponse = {
  leads: QUARANTINED,
  nextCursor: null,
  totalCount: QUARANTINED.length,
  statusCounts: { new: 2, contacted: 0, quoting: 0, won: 0, lost: 0 },
};

function leadDetail(item: AdminLeadListItem): AdminLeadDetail {
  return {
    ...item,
    phone: '+1 403 555 0142',
    marketingConsent: true,
    consentTs: item.createdAt,
    unsubscribedAt: null,
    nudgeSentAt: null,
    estimate: {
      estimateId: 'est-1',
      addressKey: item.addressKey,
      projectType: item.projectType,
      sqft: 2400,
      tier: 'premium',
      totalRangeCents: [128_000_000, 151_000_000],
      buildRangeCents: [83_000_000, 106_000_000],
      landCents: 45_000_000,
      createdAt: item.createdAt,
    },
    magicLinkStatus: 'used',
    sheetsSyncedAt: daysAgo(1),
    snapshotCount: 2,
    builderId: item.tenantKey ? 'b-1' : null,
    notes: [
      {
        id: 'n-1',
        note: 'Called twice — prefers evenings. Wants a quote for a laneway home as well as the main build.',
        createdAt: daysAgo(1),
      },
    ],
    statusHistory: [
      { oldStatus: null, newStatus: 'new', changedBy: null, changedAt: item.createdAt },
      { oldStatus: 'new', newStatus: item.status, changedBy: ADMIN_ME.email, changedAt: daysAgo(1) },
    ],
  };
}

export const ADMIN_COMMENTS: CommentListResponse = {
  comments: [
    {
      id: 'c-1',
      entityType: 'lead',
      entityId: 'lead-1',
      authorKind: 'admin',
      authorId: 'admin-1',
      authorDisplayName: 'Operations Administrator',
      visibility: 'admin_only',
      body: 'Assigned to Elite Craft — they cover the southwest communities.',
      createdAt: daysAgo(1),
      updatedAt: daysAgo(1),
      edited: false,
      deletedAt: null,
    },
  ],
};

// ── Builders ─────────────────────────────────────────────────────────────

function builder(id: string, tenantKey: string, name: string, extra: Partial<Builder> = {}): Builder {
  return {
    id,
    tenantKey,
    businessName: name,
    displayName: name,
    email: `hello@${tenantKey}.example`,
    phone: '+1 403 555 0199',
    logoUrl: null,
    accentColor: '#8a5a2b',
    allowedOrigins: [`https://www.${tenantKey}.example`, `https://staging.${tenantKey}.example`],
    plan: 'commission',
    status: 'active',
    settings: {},
    commissionRatePercent: 1,
    createdAt: daysAgo(200),
    updatedAt: daysAgo(5),
    ...extra,
  };
}

export const ADMIN_BUILDERS: BuilderListResponse = {
  builders: [
    builder('b-1', ELITE, 'Elite Craft Builders'),
    builder('b-2', NORTHERN, 'Northern Lights Custom Homes & Renovations Ltd.', { commissionRatePercent: 1.5 }),
    builder('b-3', 'bow-river-custom', 'Bow River Custom', { status: 'inactive', plan: null }),
  ],
};

// ── Users ────────────────────────────────────────────────────────────────

function user(id: string, name: string, email: string, extra: Partial<AdminUser> = {}): AdminUser {
  return {
    id,
    email,
    name,
    status: 'active',
    staffRole: null,
    isProtected: false,
    memberships: [],
    createdAt: daysAgo(90),
    updatedAt: daysAgo(3),
    ...extra,
  };
}

export const ADMIN_USERS: AdminUserListResponse = {
  users: [
    user('admin-1', 'Operations Administrator', ADMIN_ME.email, { staffRole: 'super_admin', isProtected: true }),
    user('u-2', 'Alexandra Montgomery-Whitfield', 'alexandra.montgomery-whitfield@elitecraftbuilders.example', {
      memberships: [{ builderId: 'b-1', role: 'builder_admin' }],
    }),
    user('u-3', 'Christopher Vandenberghe-Lindqvist', 'christopher.vandenberghe@northernlights.example', {
      status: 'invited',
      memberships: [{ builderId: 'b-2', role: 'builder_member' }],
    }),
    user('u-4', 'Dana Kim', 'dana.kim@feasly-internal-staff.example', { staffRole: 'viewer', status: 'disabled' }),
  ],
  total: 4,
  limit: 50,
  offset: 0,
};

// ── Billing / invoices / disputes ────────────────────────────────────────

const DISPUTED = INVOICES.find((i) => i.status === 'disputed')!;
const IN_REVIEW = INVOICES.find((i) => i.status === 'in_review')!;
const FAILED = INVOICES.find((i) => i.status === 'failed')!;

export const BILLING_HEALTH: BillingHealthResponse = {
  model: 'commission',
  stripe: { configured: true, testMode: true },
  generatedAt: new Date().toISOString(),
  mrr: { cents: null, currency: 'CAD', activeSubscriptions: 0, source: 'not_applicable' },
  collectedTrailing30d: { count: 1, commissionCents: 745_000 },
  inReview: {
    under48h: { count: 1, commissionCents: IN_REVIEW.commissionCents },
    under7d: { count: 0, commissionCents: 0 },
    overdue: { count: 0, commissionCents: 0 },
  },
  disputed: { count: 1, commissionCents: DISPUTED.commissionCents },
  dunning: [
    {
      id: FAILED.id,
      tenantKey: FAILED.tenantKey,
      commissionCents: FAILED.commissionCents,
      currency: 'CAD',
      commissionRatePercent: 1,
      contractValueCents: FAILED.contractValueCents,
      pastDueSince: daysAgo(3),
      retryCount: 1,
      lastFailureReason: 'Your card was declined. The card issuer did not provide a reason.',
      paymentMethod: 'card',
    },
  ],
  inReviewInvoices: [
    {
      id: IN_REVIEW.id,
      tenantKey: IN_REVIEW.tenantKey,
      commissionCents: IN_REVIEW.commissionCents,
      currency: 'CAD',
      reviewDueAt: daysAhead(4),
      commissionRatePercent: 1,
      contractValueCents: IN_REVIEW.contractValueCents,
      paymentMethod: 'card',
    },
  ],
  maxChargeRetries: 3,
  webhooks: {
    received24h: 14,
    lastReceivedAt: daysAgo(0.1),
    byType24h: [
      { type: 'payment_intent.succeeded', count: 9 },
      { type: 'payment_intent.payment_failed', count: 2 },
      { type: 'customer.subscription.updated', count: 3 },
    ],
    unhandled24h: 0,
    modelMismatch24h: 0,
    unprocessed: [],
    awaitingSettlement: [],
    settlementThresholdHours: 24,
  },
};

const DISPUTE_ITEM: DisputeListItem = {
  id: 'dispute-1',
  invoiceId: DISPUTED.id,
  tenantKey: DISPUTED.tenantKey,
  reason: 'Contract value differs from the signed copy — the garage was removed from scope before signing.',
  status: 'open',
  openedAt: daysAgo(2),
  slaDueAt: daysAhead(3),
  slaBreachedAt: null,
  commissionCents: DISPUTED.commissionCents,
  currency: 'CAD',
  contractValueCents: DISPUTED.contractValueCents,
  businessDaysRemaining: 3,
  breached: false,
};

export const DISPUTES: DisputeListResponse = { disputes: [DISPUTE_ITEM] };

export const DISPUTE_DETAIL: DisputeDetailResponse = {
  ...DISPUTE_ITEM,
  evidenceSnapshot: {
    invoiceId: DISPUTED.id,
    tenantKey: DISPUTED.tenantKey,
    attributionId: DISPUTED.attributionId,
    leadId: DISPUTED.leadId,
    contractValueCents: DISPUTED.contractValueCents,
    commissionCents: DISPUTED.commissionCents,
    currency: 'CAD',
    stripePaymentIntentId: null,
    status: 'disputed',
    reviewDueAt: daysAhead(1),
    disputeReason: DISPUTE_ITEM.reason,
    invoiceCreatedAt: daysAgo(6),
    disputedAt: daysAgo(2),
    effectiveRatePercent: 1,
  },
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  auditTrail: [
    {
      id: 'ev-1',
      tenantKey: DISPUTED.tenantKey,
      eventType: 'invoice.created',
      entityType: 'invoice',
      entityId: DISPUTED.id,
      payload: null,
      createdAt: daysAgo(6),
    },
    {
      id: 'ev-2',
      tenantKey: DISPUTED.tenantKey,
      eventType: 'invoice.disputed',
      entityType: 'invoice',
      entityId: DISPUTED.id,
      payload: { reason: DISPUTE_ITEM.reason },
      createdAt: daysAgo(2),
    },
  ],
};

// ── Ops: calibration, sheets, funnels, estimates ─────────────────────────

export const CALIBRATION: AdminCalibrationResponse = {
  current: {
    version: 'v3',
    calibrated: true,
    frozen: true,
    source: 'Elite Craft Builders cost sheet, 2026 Q3',
    notes: 'Recalibrated against twelve completed infill builds.',
    hardCostCategories: 18,
    softCostCategories: 6,
    tiers: ['standard', 'premium', 'luxury'],
  },
  report: {
    costDataVersion: 'v3',
    houses: [
      { houseId: 'house-01-lakeview-ridge', actualTotalCents: 98_000_000, engineTotalCents: 102_000_000, errorFraction: 0.041 },
      { houseId: 'house-02-altadore', actualTotalCents: 121_000_000, engineTotalCents: 115_500_000, errorFraction: -0.045 },
      { houseId: 'house-03-killarney', actualTotalCents: 87_500_000, engineTotalCents: 92_000_000, errorFraction: 0.051 },
    ],
    errorDistribution: { buckets: ['-10%', '-5%', '0%', '+5%', '+10%'], counts: [0, 1, 0, 2, 0] },
    sampleSize: 3,
    smallSampleWarning: 'Only 3 calibration houses — treat error figures as directional.',
    meanAbsoluteErrorFraction: 0.046,
  },
  importHistory: [
    { id: 'imp-3', importedAt: daysAgo(14), version: 'v3', houseCount: 3, importedBy: ADMIN_ME.email, status: 'frozen' },
    { id: 'imp-2', importedAt: daysAgo(60), version: 'v2', houseCount: 2, importedBy: ADMIN_ME.email, status: 'superseded' },
  ],
  hasDraftV2: false,
};

export const SHEETS_STATUS: SheetsSyncStatusResponse = {
  last_run_at: daysAgo(0.01),
  last_success_at: daysAgo(0.01),
  rows_synced_total: 1843,
  pending_count: 2,
  consecutive_failures: 0,
  lagging: false,
  run_in_flight: false,
  sheets_configured: true,
  recent_failures: [
    { at: daysAgo(3), error: 'Google Sheets API quota exceeded for quota metric "Write requests per minute per user".' },
  ],
};

export const FUNNEL: FunnelReport = {
  from: null,
  to: null,
  tenant: 'all',
  steps: [
    { step: 'address_entered', label: 'Address entered', count: 4820, conversionFromPrevious: null },
    { step: 'preview_viewed', label: 'Preview viewed', count: 3110, conversionFromPrevious: 0.645 },
    { step: 'gate_submitted', label: 'Email submitted', count: 912, conversionFromPrevious: 0.293 },
    { step: 'report_viewed', label: 'Report viewed', count: 760, conversionFromPrevious: 0.833 },
  ],
};

export const ESTIMATE_ID = 'est-1';

export const ESTIMATE_DETAIL: AdminEstimateDetail = {
  id: ESTIMATE_ID,
  projectType: 'new_build',
  inputs: { sqft: 2400, tier: 'premium', garage: 'double', basement: 'finished' },
  outputs: {
    buildRange: { low: 830_000, base: 945_000, high: 1_060_000 },
    totalRange: { low: 1_280_000, base: 1_395_000, high: 1_510_000 },
    landValue: { value: 450_000 },
  },
  rows: [
    { key: 'foundation', label: 'Foundation & excavation', range: { low: 72_000, base: 81_000, high: 90_000 } },
    { key: 'framing', label: 'Framing & structure', range: { low: 140_000, base: 158_000, high: 176_000 } },
    { key: 'finishes', label: 'Interior finishes', range: { low: 190_000, base: 214_000, high: 238_000 } },
  ],
  costDataVersion: 'v3',
  narrative: null,
  createdAt: daysAgo(3),
  linkedLeadId: 'lead-1',
  snapshots: [
    { id: 'snap-2', createdAt: daysAgo(1) },
    { id: 'snap-1', createdAt: daysAgo(3) },
  ],
};

// ── API keys ─────────────────────────────────────────────────────────────

function apiKey(id: string, name: string, extra: Partial<ApiKeyRecordResponse> = {}): ApiKeyRecordResponse {
  return {
    id,
    name,
    tenant_id: ELITE,
    key_prefix: 'feasly_live_…9f3k',
    scopes: ['property:read', 'estimate', 'lead'],
    rate_limit_per_min: 60,
    sandbox: false,
    revoked_at: null,
    last_used_at: daysAgo(1),
    created_at: daysAgo(40),
    ...extra,
  };
}

export const API_KEYS: ApiKeyListResponse = {
  keys: [
    apiKey('key-1', 'Elite Craft production website embed integration'),
    apiKey('key-2', 'Northern Lights sandbox', {
      tenant_id: NORTHERN,
      key_prefix: 'feasly_test_…a81b',
      sandbox: true,
      scopes: ['property:read', 'estimate:read'],
    }),
    apiKey('key-3', 'Retired partner key', { revoked_at: daysAgo(10), last_used_at: daysAgo(12), tenant_id: null }),
  ],
};

export const API_KEY_USAGE: readonly ApiKeyUsageAggregate[] = [
  { date: daysAgo(1).slice(0, 10), endpoint: '/api/v1/estimate', count: 42, estimates_created: 40 },
  { date: daysAgo(2).slice(0, 10), endpoint: '/api/v1/properties/lookup', count: 118, estimates_created: 0 },
];

export const SEARCH: AdminSearchResponse = {
  query: '',
  hits: [
    { kind: 'lead', id: 'lead-1', label: ADMIN_LEADS[0]!.name, sublabel: ADMIN_LEADS[0]!.email },
    { kind: 'builder', id: 'b-1', label: 'Elite Craft Builders', sublabel: ELITE },
  ],
};

// ── Router ───────────────────────────────────────────────────────────────

/** Requests the fixtures did not answer — the spec asserts this stays empty. */
export interface ApiMockHandle {
  readonly unhandled: string[];
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const notFound = (route: Route): Promise<void> =>
  json(route, { error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);

/**
 * Intercepts `/api/**` on the page. `signedIn: false` answers `/me` with
 * 401 so the login page renders in its signed-out state.
 */
export async function mockAdminApi(page: Page, opts: { signedIn: boolean }): Promise<ApiMockHandle> {
  const handle: ApiMockHandle = { unhandled: [] };
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === '/api/v1/admin/auth/me') {
      return opts.signedIn
        ? json(route, ADMIN_ME)
        : json(route, { error: { code: 'UNAUTHENTICATED', message: 'Sign in required.' } }, 401);
    }
    if (method === 'GET') {
      switch (path) {
        case '/api/v1/admin/leads':
          return json(route, url.searchParams.get('quarantinedOnly') === 'true' ? QUARANTINE_LIST : ADMIN_LEAD_LIST);
        case '/api/v1/admin/builders':
          return json(route, ADMIN_BUILDERS);
        case '/api/v1/admin/users':
          return json(route, ADMIN_USERS);
        case '/api/v1/admin/billing':
          return json(route, BILLING_HEALTH);
        case '/api/v1/admin/disputes':
          return json(route, DISPUTES);
        case '/api/v1/admin/calibration':
          return json(route, CALIBRATION);
        case '/api/v1/admin/ops/sheets-status':
          return json(route, SHEETS_STATUS);
        case '/api/v1/admin/funnels':
          return json(route, FUNNEL);
        case '/api/v1/admin/api-keys':
          return json(route, API_KEYS);
        case '/api/v1/admin/usage':
          return json(route, API_KEY_USAGE);
        case '/api/v1/admin/search':
          return json(route, { ...SEARCH, query: url.searchParams.get('q') ?? '' });
        case '/api/v1/billing/invoices': {
          const statuses = url.searchParams.get('status')?.split(',').filter(Boolean);
          return json(route, statuses ? INVOICES.filter((i) => statuses.includes(i.status)) : INVOICES);
        }
      }
      const leadComments = /^\/api\/v1\/admin\/leads\/([^/]+)\/comments$/.exec(path);
      if (leadComments) {
        return json(route, ADMIN_COMMENTS);
      }
      const leadMatch = /^\/api\/v1\/admin\/leads\/([^/]+)$/.exec(path);
      if (leadMatch) {
        const found = [...ADMIN_LEADS, ...QUARANTINED].find((l) => l.id === leadMatch[1]);
        return found ? json(route, leadDetail(found)) : notFound(route);
      }
      const builderMatch = /^\/api\/v1\/admin\/builders\/([^/]+)$/.exec(path);
      if (builderMatch) {
        const found = ADMIN_BUILDERS.builders.find((b) => b.id === builderMatch[1]);
        // #722: the drawer reads the platform-agreement block off the detail.
        return found
          ? json(route, {
              ...found,
              agreement: {
                currentVersion: '2026-11-draft-1',
                current: false,
                acceptedVersion: '2026-10-draft-0',
                acceptedAt: daysAgo(30),
                acceptedBy: { userId: 'u-2', name: 'Alexandra Montgomery-Whitfield', email: 'alexandra.montgomery-whitfield@elitecraftbuilders.example' },
              },
            } satisfies AdminBuilderDetail)
          : notFound(route);
      }
      const disputeMatch = /^\/api\/v1\/admin\/disputes\/([^/]+)$/.exec(path);
      if (disputeMatch) {
        return disputeMatch[1] === DISPUTE_DETAIL.id ? json(route, DISPUTE_DETAIL) : notFound(route);
      }
      const estimateMatch = /^\/api\/v1\/admin\/estimates\/([^/]+)$/.exec(path);
      if (estimateMatch) {
        return estimateMatch[1] === ESTIMATE_ID ? json(route, ESTIMATE_DETAIL) : notFound(route);
      }
      const invoiceMatch = /^\/api\/v1\/billing\/invoices\/([^/]+)$/.exec(path);
      if (invoiceMatch) {
        const found = INVOICES.find((i) => i.id === invoiceMatch[1]);
        return found ? json(route, found) : notFound(route);
      }
    }
    handle.unhandled.push(`${method} ${path}`);
    return json(route, { error: { code: 'NOT_FOUND', message: 'No e2e fixture.' } }, 404);
  });
  return handle;
}
