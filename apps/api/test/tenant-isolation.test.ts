/**
 * Tenant / token isolation suite (#731 AC2).
 *
 * Covers every parameterised `builder-session` and `magic-token` route in
 * the registry, plus parameterised `admin` routes that builder roles can
 * reach through a `builder:*` permission (builder admins: own orgs only): builder A asking for builder B's lead / user / comment /
 * invoice / PDF / dispute, or a token used against someone else's
 * resource (or an unknown/forged/expired token), gets 404 or 403 with no
 * data and no mutation.
 *
 * The cases live next to each service's fixtures (that's where the fakes
 * are). This file is the INDEX and the GATE:
 *  1. Coverage: every such registry route has an entry below. Adding a new
 *     parameterised builder/magic-token route without a case fails CI.
 *  2. Every referenced case exists verbatim as an `it(...)` title in the
 *     named test file (renaming or deleting a case fails CI). The cases
 *     run as part of the same `vitest` run, so the suite is green only
 *     when they are.
 *
 * 404 vs 403: some services answer cross-tenant ids with 403 + an audit
 * row (auth/04 AC2: denials are audit-logged) rather than 404. Both are
 * accepted here as "isolated": no data returned, nothing changed. The
 * existing 403 contracts were kept rather than changed.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_REGISTRY } from '../src/registry/route-registry';

interface CaseRef {
  /** Test file under apps/api/test. */
  readonly file: string;
  /** Exact `it(...)` title as written in source. */
  readonly title: string;
}

interface IsolationEntry {
  readonly cases: readonly CaseRef[];
  /**
   * Only for registry routes with `status: 'planned'` (no handler yet).
   * The gate fails as soon as the route goes live while still pending.
   */
  readonly pendingUntilLive?: string;
}

const ISOLATION_CASES: Readonly<Record<string, IsolationEntry>> = {
  // ── Admin user routes reachable by builder admins ────────────────
  'GET /api/v1/admin/users/{id}': {
    cases: [{ file: 'admin-users.route.test.ts', title: 'get: builder admin cannot read users outside their orgs (403)' }],
  },
  'PATCH /api/v1/admin/users/{id}': {
    cases: [
      { file: 'admin-users.route.test.ts', title: 'update: builder admin cannot patch a user outside their orgs (403, #731 tenant isolation)' },
      { file: 'admin-users.route.test.ts', title: 'update: builder admin cannot disable a user with memberships in other orgs (403)' },
    ],
  },
  'POST /api/v1/admin/users/{id}/resend-invite': {
    cases: [{ file: 'admin-users.route.test.ts', title: 'resendInvite: builder admin cannot resend for a user outside their orgs (403, #731 tenant isolation)' }],
  },
  // ── Builder users ────────────────────────────────────────────────
  'PATCH /api/v1/builder/users/{id}': {
    cases: [{ file: 'builder-users.route.test.ts', title: 'update refuses targets outside the active org' }],
  },
  'POST /api/v1/builder/users/{id}/resend-invite': {
    cases: [{ file: 'builder-users.route.test.ts', title: 'refuses targets outside the active org (403)' }],
  },
  'DELETE /api/v1/builder/users/{id}': {
    cases: [{ file: 'builder-users.route.test.ts', title: 'remove refuses targets outside the active org (#731 tenant isolation)' }],
  },
  // ── Builder leads ────────────────────────────────────────────────
  'PATCH /api/v1/builder/leads/{id}': {
    cases: [
      { file: 'builder-leads.service.test.ts', title: 'updateStatus on another builder lead throws 403 and audits (auth/04 AC2)' },
      { file: 'db-migrations.test.ts', title: "findByIdAndBuilderId and updateStatusForBuilder never touch another builder\\'s rows" },
    ],
  },
  'POST /api/v1/builder/leads/{id}/mark-won': {
    cases: [{ file: 'builder-leads.service.test.ts', title: "another builder's lead is 403 (audit-logged), never notified" }],
  },
  'GET /api/v1/builder/leads/{id}': {
    cases: [
      // Store-level scoping the handler will use (cross-tenant read → null).
      { file: 'db-migrations.test.ts', title: "findByIdAndBuilderId and updateStatusForBuilder never touch another builder\\'s rows" },
    ],
    pendingUntilLive: 'No handler yet; add a service/route cross-tenant 404 case when it ships.',
  },
  // ── Builder comments ─────────────────────────────────────────────
  'GET /api/v1/builder/leads/{leadId}/comments': {
    cases: [{ file: 'builder-comments.service.test.ts', title: 'returns 404 for a lead that belongs to another builder' }],
  },
  'POST /api/v1/builder/leads/{leadId}/comments': {
    cases: [{ file: 'builder-comments.service.test.ts', title: 'cannot comment on another builder\\u2019s lead (404, nothing written — #731)' }],
  },
  'PATCH /api/v1/builder/comments/{commentId}': {
    cases: [{ file: 'builder-comments.service.test.ts', title: 'cannot edit a comment on another builder\\u2019s lead (404, unchanged — #731)' }],
  },
  // ── Builder billing ──────────────────────────────────────────────
  'GET /api/v1/billing/invoices/{id}': {
    cases: [{ file: 'billing.service.test.ts', title: 'getInvoice 403s for another tenant invoice' }],
  },
  'GET /api/v1/billing/invoices/{id}/pdf': {
    cases: [
      { file: 'invoice-pdf.service.test.ts', title: "another tenant's invoice id is a 404" },
      { file: 'billing-invoice-pdf.adapter.test.ts', title: "returns a 404 problem for another tenant's invoice id" },
    ],
  },
  'PUT /api/v1/billing/invoices/{id}/payment-method': {
    cases: [{ file: 'commission.service.test.ts', title: "400s on an unknown method, 403s for another tenant's invoice, 404s for an unknown invoice" }],
  },
  'POST /api/v1/billing/invoices/{id}/dispute': {
    cases: [{ file: 'billing.service.test.ts', title: 'disputeInvoice 403s for another tenant invoice and records nothing (#731)' }],
  },
  // ── Magic-token routes ───────────────────────────────────────────
  'GET /api/v1/reports/{reportToken}': {
    cases: [
      { file: 'phase2-report.test.ts', title: 'answers 404 for unknown tokens' },
      { file: 'phase2-report.test.ts', title: 'answers 404 for expired tokens (same response as unknown — no oracle)' },
    ],
  },
  'POST /api/v1/reports/{reportToken}/revisions': {
    cases: [
      { file: 'phase2-report.test.ts', title: 'answers 404 for unknown tokens' },
      { file: 'phase2-report.test.ts', title: 'answers 403 for a partner token — revisions are owner-only' },
    ],
  },
  'POST /api/v1/privacy/erase-requests/{requestId}/confirm': {
    cases: [
      { file: 'privacy.service.test.ts', title: 'rejects a cross-user confirm with 403 + audit row (AC2)' },
      { file: 'privacy.service.test.ts', title: '404s on an unknown request id' },
    ],
  },
  'POST /api/v1/estimates/{estimateId}/narrative': {
    cases: [
      { file: 'narrative.service.test.ts', title: 'rejects cross-user access with 403' },
      { file: 'narrative.service.test.ts', title: 'rejects invalid bearer token with 401' },
    ],
  },
  'GET /api/v1/unsubscribe/{token}': {
    cases: [
      { file: 'unsubscribe.service.test.ts', title: 'AC1: a forged token is rejected with 403 (no oracle for lead IDs)' },
      { file: 'unsubscribe.service.test.ts', title: 'a token for an unknown lead is rejected with 403 (no oracle)' },
    ],
  },
  'POST /api/v1/unsubscribe/{token}': {
    cases: [
      { file: 'unsubscribe.service.test.ts', title: 'a token for lead A never unsubscribes lead B' },
      { file: 'unsubscribe.service.test.ts', title: 'AC1: a forged token cannot unsubscribe anyone (403, no state change)' },
    ],
  },
};

const TEST_DIR = __dirname;

function isParameterisedTenantRoute(e: (typeof ROUTE_REGISTRY)[number]): boolean {
  if (!e.path.includes('{')) return false;
  if (e.auth === 'builder-session' || e.auth === 'magic-token') return true;
  // Admin routes builder admins can reach are tenant-scoped too.
  const perms: readonly string[] = [
    ...e.permissions,
    ...(('permissionsAnyOf' in e ? e.permissionsAnyOf : undefined) ?? []),
  ];
  return e.auth === 'admin' && perms.some((p) => p.startsWith('builder:'));
}

function titleDeclared(source: string, title: string): boolean {
  // Match the title as the first argument of it(...)/test(...), any quote style.
  return ['\'', '"', '`'].some((q) =>
    source.includes(`it(${q}${title}${q}`) || source.includes(`test(${q}${title}${q}`),
  );
}

describe('tenant isolation suite (#731 AC2)', () => {
  const routes = ROUTE_REGISTRY.filter(isParameterisedTenantRoute);
  const keys = new Set(routes.map((e) => `${e.method} ${e.path}`));

  it('every parameterised tenant-scoped route has an isolation case', () => {
    const missing = [...keys].filter((k) => !(k in ISOLATION_CASES));
    expect(
      missing,
      'add a cross-tenant/cross-token case and list it in ISOLATION_CASES',
    ).toEqual([]);
  });

  it('the index names only real parameterised tenant routes', () => {
    const stale = Object.keys(ISOLATION_CASES).filter((k) => !keys.has(k));
    expect(stale).toEqual([]);
  });

  it('pending entries are allowed only while the route is planned', () => {
    const livePending = routes
      .filter((e) => e.status === 'live')
      .map((e) => `${e.method} ${e.path}`)
      .filter((k) => ISOLATION_CASES[k]?.pendingUntilLive);
    expect(livePending).toEqual([]);
  });

  for (const [route, entry] of Object.entries(ISOLATION_CASES)) {
    it(`${route}: every referenced case exists`, () => {
      expect(entry.cases.length).toBeGreaterThan(0);
      for (const ref of entry.cases) {
        const p = join(TEST_DIR, ref.file);
        expect(existsSync(p), `${ref.file} missing`).toBe(true);
        const src = readFileSync(p, 'utf8');
        expect(titleDeclared(src, ref.title), `${ref.file}: it('${ref.title}') not found`).toBe(true);
      }
    });
  }
});
