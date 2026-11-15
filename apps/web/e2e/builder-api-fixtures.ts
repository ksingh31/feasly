/**
 * #536: contract-shaped API fixtures for the builder portal e2e.
 *
 * Every builder endpoint the portal reads is answered here via Playwright
 * request interception, so the suite runs against a static production
 * build with no Functions host or database. Shapes are typed against
 * `@feasly/contracts` (and the web's builder-auth contracts) so a contract
 * change breaks the e2e typecheck instead of silently drifting.
 *
 * The data deliberately includes long names / emails / addresses: the
 * overflow check is only meaningful when content pushes against the
 * column widths. All dollar figures are fixture integers standing in for
 * server-computed values — the client never computes them.
 */
import type { Page, Route } from '@playwright/test';
import type {
  AgreementStatus,
  BuilderAuthMeResponse,
  BuilderOnboardingStatus,
  BuilderBillingOverviewResponse,
  BuilderLeadListItem,
  BuilderLeadListResponse,
  BuilderLeadNeedsYouItem,
  BuilderLeadsNeedsYouResponse,
  CardOnFileStatus,
  CommentListResponse,
  CommissionInvoice,
  CommissionRateResponse,
} from '@feasly/contracts';
import type {
  BuilderMembershipsResponse,
  BuilderTeamListResponse,
} from '../src/app/features/builder/builder-auth.contracts';
import type { BuilderPaymentMethod } from '../src/app/features/builder/builder-payment-methods';

const TENANT = 'elite-craft-builders';

/** Fixture timestamps are relative to now so "waiting N days" copy stays stable. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
function daysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export const ME: BuilderAuthMeResponse = {
  authenticated: true,
  email: 'alexandra.montgomery-whitfield@elitecraftbuilders.example',
  tenantKey: TENANT,
  role: 'builder_admin',
  viewAs: null,
  viewAsDisplayName: null,
  realEmail: null,
};

export const MEMBERSHIPS: BuilderMembershipsResponse = {
  memberships: [
    { builderId: TENANT, builderName: 'Elite Craft Builders', role: 'builder_admin' },
    {
      builderId: 'northern-lights-custom-homes',
      builderName: 'Northern Lights Custom Homes & Renovations Ltd.',
      role: 'builder_member',
    },
  ],
};

/** Commission figures are literal server outputs (1% of the contract value). */
function invoice(
  n: number,
  status: CommissionInvoice['status'],
  leadName: string,
  contractValueCents: number,
  commissionCents: number,
  paymentMethod: BuilderPaymentMethod = 'card',
): CommissionInvoice {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    tenantKey: TENANT,
    attributionId: `attr-${n}`,
    leadId: `lead-${n}`,
    leadName,
    contractValueCents,
    commissionCents,
    currency: 'CAD',
    stripePaymentIntentId: status === 'paid' ? `pi_${n}` : null,
    status,
    reviewDueAt: status === 'in_review' ? daysAhead(4) : null,
    finalizedAt: status === 'paid' || status === 'failed' ? daysAgo(3) : null,
    paidAt: status === 'paid' ? daysAgo(2) : null,
    slaBreached: false,
    disputeReason: status === 'disputed' ? 'Contract value differs from the signed copy.' : null,
    commissionRateOverride: null,
    commissionRatePercent: 1,
    effectiveRatePercent: 1,
    manualPaymentMethod: null,
    paymentReference: null,
    invoiceNumber: `INV-00${40 + n}`,
    paymentMethod,
    createdAt: daysAgo(10 - n),
    updatedAt: daysAgo(n),
  };
}

export const INVOICES: readonly CommissionInvoice[] = [
  invoice(1, 'in_review', 'Bartholomew & Genevieve Okonkwo-Hargreaves', 128_450_000, 1_284_500),
  invoice(2, 'failed', 'Priya Ramanathan-Castellanos', 96_000_000, 960_000),
  invoice(3, 'paid', 'Jordan Lee', 74_500_000, 745_000, 'e_transfer'),
  invoice(4, 'disputed', 'Maximilian Featherstonehaugh', 110_250_000, 1_102_500, 'cheque'),
];

const LONG_ADDRESS = '12345 Lakeview Ridge Crescent Southwest, Calgary';

function lead(
  n: number,
  name: string,
  status: BuilderLeadListItem['status'],
  extra: Partial<BuilderLeadListItem> = {},
): BuilderLeadListItem {
  return {
    id: `lead-${n}`,
    name,
    email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example-mail-provider.ca`,
    phone: '+1 403 555 0' + String(100 + n),
    timeline: '6-12 months',
    leadScore: 90 - n * 7,
    status,
    statusUpdatedAt: daysAgo(n),
    addressKey: `${n}${LONG_ADDRESS}`,
    projectType: 'Duplex infill with legal secondary suite',
    createdAt: daysAgo(n + 2),
    hasInvoice: false,
    invoiceSummary: null,
    commentCount: 0,
    latestComment: null,
    needsRecording: false,
    ...extra,
  };
}

const LEADS: readonly BuilderLeadListItem[] = [
  lead(1, 'Bartholomew & Genevieve Okonkwo-Hargreaves', 'new'),
  lead(2, 'Priya Ramanathan-Castellanos', 'contacted', {
    commentCount: 2,
    latestComment: {
      body: 'Called twice — prefers evenings. Wants a quote for a laneway home as well as the main build.',
      authorDisplayName: 'Alexandra Montgomery-Whitfield',
      authorKind: 'builder',
      createdAt: daysAgo(1),
    },
  }),
  lead(3, 'Jordan Lee', 'quoted'),
  lead(4, 'Maximilian Featherstonehaugh', 'won', { needsRecording: true }),
  lead(5, 'Sam Wu', 'lost'),
];

export const LEAD_LIST: BuilderLeadListResponse = {
  leads: LEADS,
  summary: { total: 5, new: 1, contacted: 1, quoted: 1, won: 1, lost: 1, needsRecording: 1 },
};

function needsYouItem(l: BuilderLeadListItem, waitingDays: number): BuilderLeadNeedsYouItem {
  return {
    id: l.id,
    name: l.name,
    email: l.email,
    phone: l.phone,
    timeline: l.timeline,
    leadScore: l.leadScore,
    status: l.status,
    addressKey: l.addressKey,
    createdAt: l.createdAt,
    statusChangedAt: l.statusUpdatedAt,
    waitingSince: daysAgo(waitingDays),
  };
}

export const NEEDS_YOU: BuilderLeadsNeedsYouResponse = {
  uncontacted: [needsYouItem(LEADS[0]!, 2)],
  stale: [needsYouItem(LEADS[1]!, 9)],
  wonWithoutContract: [needsYouItem(LEADS[3]!, 4)],
  staleAfterDays: 7,
  counts: { total: 5, new: 1, contacted: 1, quoted: 1, won: 1, lost: 1 },
};

export const CARD: CardOnFileStatus = { hasCard: true, brand: 'visa', last4: '4242', expMonth: 8, expYear: 2029 };

export const OVERVIEW: BuilderBillingOverviewResponse = {
  planType: 'commission',
  commissionRatePercent: 1,
  currency: 'CAD',
  outstandingCents: 2_244_500,
  outstandingCount: 2,
  nextCharge: {
    invoiceId: INVOICES[0]!.id,
    invoiceNumber: INVOICES[0]!.invoiceNumber,
    amountCents: INVOICES[0]!.commissionCents,
    chargeAt: daysAhead(4),
    cardLast4: '4242',
  },
  failedCount: 1,
  failedInvoices: [
    {
      id: INVOICES[1]!.id,
      invoiceNumber: INVOICES[1]!.invoiceNumber,
      leadId: INVOICES[1]!.leadId,
      commissionCents: INVOICES[1]!.commissionCents,
    },
  ],
  disputedCount: 1,
  card: CARD,
};

export const COMMISSION_RATE: CommissionRateResponse = { commissionRatePercent: 1 };

export const TEAM: BuilderTeamListResponse = {
  users: [
    {
      id: 'u1',
      name: 'Alexandra Montgomery-Whitfield',
      email: ME.email,
      role: 'builder_admin',
      status: 'active',
      createdAt: daysAgo(120),
    },
    {
      id: 'u2',
      name: 'Christopher Vandenberghe-Lindqvist',
      email: 'christopher.vandenberghe-lindqvist@elitecraftbuilders.example',
      role: 'builder_member',
      status: 'invited',
      createdAt: daysAgo(3),
    },
    {
      id: 'u3',
      name: 'Dana Kim',
      email: 'dana@elitecraftbuilders.example',
      role: 'builder_member',
      status: 'deactivated',
      createdAt: daysAgo(60),
    },
  ],
};

export const COMMENTS: CommentListResponse = {
  comments: [
    {
      id: 'c-1',
      entityType: 'lead',
      entityId: 'lead-2',
      authorKind: 'builder',
      authorId: 'u1',
      authorDisplayName: 'Alexandra Montgomery-Whitfield',
      visibility: 'org',
      body: 'Called twice — prefers evenings. Wants a quote for a laneway home as well as the main build.',
      createdAt: daysAgo(1),
      updatedAt: daysAgo(1),
      edited: false,
      deletedAt: null,
    },
  ],
};

/** #722: accepted, draft text long enough to scroll on a phone. */
export const AGREEMENT: AgreementStatus = {
  version: '2026-11-draft-1',
  current: true,
  acceptedAt: daysAgo(4),
  acceptedBy: { userId: 'u1', name: 'Alexandra Montgomery-Whitfield', email: ME.email },
  canAccept: true,
  document: {
    version: '2026-11-draft-1',
    title: 'Feasly Platform Agreement for Builders',
    status: 'draft-pending-lawyer',
    sections: [
      {
        heading: '1. Commission',
        paragraphs: [
          'You pay Feasly a commission on the signed construction contract value of an attributed lead, excluding land, at the rate set for your organization.',
        ],
      },
      {
        heading: '2. Attribution window',
        paragraphs: ['A lead is attributed to Feasly for 12 months from when it was first sent to you.'],
      },
      {
        heading: '3. Reporting signed contracts',
        paragraphs: ['Record every signed contract with an attributed lead within 14 days of signing.'],
      },
    ],
  },
};

/** Agreement done, other steps mixed — the checklist renders on the Leads home. */
export const ONBOARDING: BuilderOnboardingStatus = {
  agreementAccepted: true,
  profileComplete: true,
  paymentMethodSet: true,
  embedVerified: false,
  teamInvited: true,
  complete: false,
  isAdmin: true,
  agreement: AGREEMENT,
};

/** Requests the fixtures did not answer — the spec asserts this stays empty. */
export interface ApiMockHandle {
  readonly unhandled: string[];
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * Intercepts `/api/**` on the page. `signedIn: false` answers `/me` with
 * 401 so public pages render in their signed-out state.
 */
export async function mockBuilderApi(page: Page, opts: { signedIn: boolean }): Promise<ApiMockHandle> {
  const handle: ApiMockHandle = { unhandled: [] };
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === '/api/v1/builder/auth/me') {
      return opts.signedIn
        ? json(route, ME)
        : json(route, { error: { code: 'UNAUTHENTICATED', message: 'Sign in required.' } }, 401);
    }
    if (method === 'GET') {
      switch (path) {
        case '/api/v1/builder/auth/memberships':
          return json(route, MEMBERSHIPS);
        case '/api/v1/builder/leads':
          return json(route, LEAD_LIST);
        case '/api/v1/builder/leads/needs-you':
          return json(route, NEEDS_YOU);
        case '/api/v1/builder/billing/overview':
          return json(route, OVERVIEW);
        case '/api/v1/builder/users':
          return json(route, TEAM);
        case '/api/v1/builder/agreement':
          return json(route, AGREEMENT);
        case '/api/v1/builder/onboarding':
          return json(route, ONBOARDING);
        case '/api/v1/billing/card':
          return json(route, CARD);
        case '/api/v1/billing/commission-rate':
          return json(route, COMMISSION_RATE);
        case '/api/v1/billing/payment-method':
          return json(route, { defaultMethod: 'card' });
        case '/api/v1/billing/invoices': {
          const statuses = url.searchParams.get('status')?.split(',').filter(Boolean);
          return json(route, statuses ? INVOICES.filter((i) => statuses.includes(i.status)) : INVOICES);
        }
      }
      if (/^\/api\/v1\/builder\/leads\/[^/]+\/comments$/.test(path)) {
        return json(route, COMMENTS);
      }
      const invoiceMatch = /^\/api\/v1\/billing\/invoices\/([^/]+)$/.exec(path);
      if (invoiceMatch) {
        const found = INVOICES.find((i) => i.id === invoiceMatch[1]);
        return found ? json(route, found) : json(route, { error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
      }
    }
    handle.unhandled.push(`${method} ${path}`);
    return json(route, { error: { code: 'NOT_FOUND', message: 'No e2e fixture.' } }, 404);
  });
  return handle;
}
