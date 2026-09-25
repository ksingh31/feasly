/**
 * Canonical API route registry (api-mcp/08 — frozen).
 *
 * This is the SINGLE source of truth for every Feasly API route: method,
 * canonical path, auth, rate limit, and implementation status. The table in
 * `docs/plan/TECH_PLAN.md` (§16) is generated from this file — a conformance
 * test (`test/route-registry.conformance.test.ts`) fails CI if they drift.
 *
 * Rules:
 * - No story, route, function adapter, or OpenAPI path may invent a route
 *   name that is not in this table. Add the route here FIRST, then implement.
 * - `status: 'live'` means a Function binding exists on main. `'planned'`
 *   means a story references it but it is not implemented yet.
 * - Paths use `{param}` for path parameters (Azure Functions binding syntax).
 * - Rate limits are the frozen values from TECH_PLAN.md §13.3; the zod
 *   config in `src/config.ts` is env-overridable but defaults to these.
 *
 * Pure module: no I/O, no env, no imports from db/routes/services.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Who may call the route. */
export type RouteAuth =
  /** Fully public — no credential required (rate limited by IP). */
  | 'none'
  /** Bearer API key (`Authorization: Bearer feasly_live_…`), M5 agent API. */
  | 'api-key'
  /** Magic-link / one-time token IS the credential (query or path param). */
  | 'magic-token'
  /** Admin session cookie (admin/01); interim: X-Admin-Key pre-shared key. */
  | 'admin'
  /** Builder dashboard session (embed/09+). */
  | 'builder-session'
  /** Stripe-Signature header on the webhook endpoint. */
  | 'stripe-signature';

export interface ApiRouteEntry {
  readonly method: HttpMethod;
  /** Canonical path, e.g. '/api/v1/estimate'. `{param}` = path parameter. */
  readonly path: string;
  readonly auth: RouteAuth;
  /** Frozen human-readable limit, e.g. '20/hr per IP'. */
  readonly rateLimit: string;
  readonly status: 'live' | 'planned';
  readonly summary: string;
}

export const ROUTE_REGISTRY: readonly ApiRouteEntry[] = [
  // ── Health (outside /v1) ──────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/health',
    auth: 'none',
    rateLimit: '100/min per IP',
    status: 'live',
    summary: 'Liveness + dependency checks (2s DB timeout).',
  },

  // ── Public v1: consumer funnel ────────────────────────────────────
  {
    method: 'POST',
    path: '/api/v1/estimate',
    auth: 'none',
    rateLimit: '20/hr per IP · 20/hr per tenant (embed)',
    status: 'live',
    summary:
      'Run a cost estimate (deterministic engine). Public for the web funnel; ' +
      'agent/MCP callers send an API key.',
  },
  {
    method: 'POST',
    path: '/api/v1/leads',
    auth: 'none',
    rateLimit: '10/min per IP (dedicated lead limiter)',
    status: 'live',
    summary:
      'Submit a lead (email required, phone optional). Sends the magic-link ' +
      'email. 90-day dedupe window returns the existing lead.',
  },
  {
    method: 'GET',
    path: '/api/v1/magic-link/verify',
    auth: 'magic-token',
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'Verify a magic-link token (?token=). Resolves to the newest estimate ' +
      'for the email + property. Token IS the credential.',
  },
  {
    method: 'POST',
    path: '/api/v1/magic-link/reissue',
    auth: 'none',
    rateLimit: '60s cooldown · 5/hr per email+IP',
    status: 'live',
    summary:
      'Idempotent "resend my link". Unknown emails get the same response ' +
      '(no enumeration oracle).',
  },
  {
    method: 'GET',
    path: '/api/v1/reports/{reportToken}',
    auth: 'magic-token',
    rateLimit: '100/min per IP',
    status: 'planned',
    summary:
      'Resolve a report snapshot by token (immutable shared snapshot; ' +
      'see report redesign). Token IS the credential.',
  },

  // ── Public v1: property data ──────────────────────────────────────
  {
    method: 'GET',
    path: '/api/v1/properties/autocomplete',
    auth: 'none',
    rateLimit: '60/min per IP',
    status: 'live',
    summary:
      'Calgary address autocomplete (City of Calgary assessment roll). ' +
      'Free by design.',
  },
  {
    method: 'GET',
    path: '/api/v1/properties/lookup',
    auth: 'none',
    rateLimit: '60/min per IP',
    status: 'live',
    summary:
      'Property record lookup (assessed value, lot, zoning). Deterministic ' +
      'multi-parcel selection. OUT_OF_COVERAGE for non-Calgary.',
  },

  // ── Public v1: analytics + privacy ────────────────────────────────
  {
    method: 'POST',
    path: '/api/v1/events',
    auth: 'none',
    rateLimit: '300/min per IP (dedicated analytics limiter)',
    status: 'live',
    summary:
      'First-party analytics ingest (consent-gated funnel events). Payloads ' +
      'require a valid consent_ts.',
  },
  {
    method: 'GET',
    path: '/api/v1/privacy/export',
    auth: 'magic-token',
    rateLimit: '100/min per IP',
    status: 'live',
    summary: 'PIPEDA data export for the token holder.',
  },
  {
    method: 'POST',
    path: '/api/v1/privacy/erase-requests',
    auth: 'magic-token',
    rateLimit: '10/min per IP',
    status: 'live',
    summary: 'Request erasure; returns a requestId for confirmation.',
  },
  {
    method: 'POST',
    path: '/api/v1/privacy/erase-requests/{requestId}/confirm',
    auth: 'magic-token',
    rateLimit: '10/min per IP',
    status: 'live',
    summary: 'Confirm an erasure request (second factor via email link).',
  },
  {
    method: 'POST',
    path: '/api/v1/estimates/{estimateId}/narrative',
    auth: 'magic-token',
    rateLimit: '100/min per IP + 5/day per estimate (cost guard)',
    status: 'live',
    summary:
      'Generate (or return cached) the AI narrative for an estimate. ' +
      'LLM writes narrative only; figures are deterministic.',
  },
  {
    method: 'GET',
    path: '/api/v1/unsubscribe/{token}',
    auth: 'magic-token',
    rateLimit: '100/min per IP',
    status: 'live',
    summary: 'Unsubscribe landing state (token IS the credential).',
  },
  {
    method: 'POST',
    path: '/api/v1/unsubscribe/{token}',
    auth: 'magic-token',
    rateLimit: '10/min per IP',
    status: 'live',
    summary: 'Record the opt-out (CASL).',
  },

  // ── Public v1: content / embed / docs ─────────────────────────────
  {
    method: 'GET',
    path: '/api/v1/communities/{slug}/stats',
    auth: 'none',
    rateLimit: '100/min per IP',
    status: 'live',
    summary: 'Prerendered community page statistics (SEO content engine).',
  },
  {
    method: 'GET',
    path: '/api/v1/embed/config',
    auth: 'none',
    rateLimit: '120/min per tenant key',
    status: 'live',
    summary:
      'Public embed config (?key=tenant). Logo, accent colour, contact ' +
      'fallback. Unknown keys → 404 UNKNOWN_TENANT.',
  },
  {
    method: 'POST',
    path: '/api/v1/embed/session',
    auth: 'none',
    rateLimit: '30/min per tenant key',
    status: 'planned',
    summary:
      'Exchange a single-use embed relay code for a 12h session token ' +
      '(embed/06). Replays/expired → 410.',
  },
  {
    method: 'POST',
    path: '/api/v1/chat/ask',
    auth: 'none',
    rateLimit: '20/hr per IP',
    status: 'planned',
    summary:
      'Grounded chat assistant (consumer/05). Session-scoped, rate-limited, ' +
      'allowlisted. Deterministic engine owns all dollar figures.',
  },
  {
    method: 'GET',
    path: '/api/v1/openapi.json',
    auth: 'none',
    rateLimit: '100/min per IP (1h cache)',
    status: 'live',
    summary: 'Generated OpenAPI 3.1 spec (api-mcp/03). No auth by design.',
  },

  // ── Admin v1 (session cookie; interim X-Admin-Key) ────────────────
  {
    method: 'POST',
    path: '/api/v1/admin/auth/request',
    auth: 'none',
    rateLimit: '5/hr per email+IP',
    status: 'planned',
    summary:
      'Request an admin magic link. Identical response for allowlisted and ' +
      'non-allowlisted emails (no enumeration oracle).',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/auth/verify/{token}',
    auth: 'magic-token',
    rateLimit: '10/min per IP',
    status: 'planned',
    summary:
      'Consume the admin magic link → httpOnly Secure SameSite=Lax session ' +
      'cookie, 7-day expiry. Single-use (replay-safe).',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/api-keys',
    auth: 'admin',
    rateLimit: '100/min per session',
    status: 'live',
    summary: 'List API keys (masked, paginated).',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/api-keys',
    auth: 'admin',
    rateLimit: '10/min per session',
    status: 'live',
    summary:
      'Issue an API key. Plaintext returned once; only the SHA-256 hash is ' +
      'stored. Scopes + per-key rate limit.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/api-keys/{id}/rotate',
    auth: 'admin',
    rateLimit: '10/min per session',
    status: 'live',
    summary: 'Rotate a key (old key stays valid for a grace window).',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/api-keys/{id}/revoke',
    auth: 'admin',
    rateLimit: '10/min per session',
    status: 'live',
    summary: 'Revoke a key immediately. Audit-logged.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/leads',
    auth: 'admin',
    rateLimit: '300/min per session',
    status: 'planned',
    summary:
      'Leads explorer (admin/02): filters, free-text search, cursor ' +
      'pagination.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/leads/{id}',
    auth: 'admin',
    rateLimit: '300/min per session',
    status: 'planned',
    summary: 'Lead detail: estimate summary, timeline, consent, attribution.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/leads/{id}/notes',
    auth: 'admin',
    rateLimit: '60/min per session',
    status: 'planned',
    summary: 'Append-only lead notes.',
  },
  {
    method: 'PATCH',
    path: '/api/v1/admin/leads/{id}/status',
    auth: 'admin',
    rateLimit: '60/min per session',
    status: 'planned',
    summary:
      'Lead status (new/contacted/quoting/won/lost). Writes ' +
      'lead_status_history; audit-logged.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/leads/export.csv',
    auth: 'admin',
    rateLimit: '10/min per session',
    status: 'planned',
    summary: 'CSV export of the filtered lead set.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/estimates/{id}',
    auth: 'admin',
    rateLimit: '300/min per session',
    status: 'planned',
    summary: 'Estimate lookup for support/debugging.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/funnels',
    auth: 'admin',
    rateLimit: '300/min per session',
    status: 'live',
    summary: 'Funnel dashboards (admin/07): step drop-off, gate conversion.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/usage',
    auth: 'admin',
    rateLimit: '300/min per session',
    status: 'planned',
    summary: 'Per-key usage metering (api-mcp/07).',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/calibration',
    auth: 'admin',
    rateLimit: '300/min per session',
    status: 'planned',
    summary: 'Calibration console reads (admin/09).',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/ops/sheets-status',
    auth: 'admin',
    rateLimit: '300/min per session',
    status: 'planned',
    summary: 'Sheets sync worker status (admin/05).',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/ops/sheets-sync-now',
    auth: 'admin',
    rateLimit: '10/min per session',
    status: 'planned',
    summary: 'Trigger an immediate Sheets sync (admin/04).',
  },

  // ── Builder portal v1 (builder dashboard sessions) ───────────────
  {
    method: 'POST',
    path: '/api/v1/builder/agreement/accept',
    auth: 'none',
    rateLimit: '10/min per IP',
    status: 'planned',
    summary:
      'Accept the platform agreement (clickwrap, embed/10). Lawyer text ' +
      'pending — placeholder records acceptance.',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/leads',
    auth: 'builder-session',
    rateLimit: '300/min per session',
    status: 'planned',
    summary: 'Builder pipeline dashboard: attributed leads (embed/09).',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/leads/{id}',
    auth: 'builder-session',
    rateLimit: '300/min per session',
    status: 'planned',
    summary: 'Attributed lead detail (tenant-scoped).',
  },

  // ── Billing webhooks ──────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/v1/stripe/webhooks',
    auth: 'stripe-signature',
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'Stripe webhook receiver (billing track). Signature-verified; ' +
      'idempotent event handling.',
  },
];

/** Lookup key: `METHOD /path`. */
export function registryKey(method: HttpMethod, path: string): string {
  return `${method} ${path}`;
}

/** All registry keys, for conformance tests. */
export function registryKeys(): ReadonlySet<string> {
  return new Set(ROUTE_REGISTRY.map((e) => registryKey(e.method, e.path)));
}

/**
 * Normalize a route literal found in code or docs to its registry form.
 * - Strips trailing punctuation (`.`, `,`, `)`, backticks handled by caller).
 * - Collapses concrete path segments to `{param}` where the registry has a
 *   parameter (matches segment-by-segment; extra segments fail the match).
 * Returns the `METHOD path` key, or null if no registry entry matches.
 */
export function resolveToRegistry(
  method: HttpMethod,
  rawPath: string,
): string | null {
  const clean = rawPath.replace(/[.,;:!?)\]]+$/, '');
  for (const entry of ROUTE_REGISTRY) {
    if (entry.method !== method) continue;
    if (entry.path === clean) return registryKey(entry.method, entry.path);
    const entrySegs = entry.path.split('/');
    const cleanSegs = clean.split('/');
    if (entrySegs.length !== cleanSegs.length) continue;
    let ok = true;
    for (let i = 0; i < entrySegs.length; i++) {
      const es = entrySegs[i]!;
      if (es.startsWith('{') && es.endsWith('}')) continue;
      if (es !== cleanSegs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return registryKey(entry.method, entry.path);
  }
  return null;
}

/** Render the frozen markdown table for TECH_PLAN.md §16. */
export function renderRegistryTable(): string {
  const lines = [
    '| Method | Path | Auth | Rate limit | Status | Summary |',
    '|---|---|---|---|---|---|',
  ];
  for (const e of ROUTE_REGISTRY) {
    lines.push(
      `| ${e.method} | \`${e.path}\` | ${e.auth} | ${e.rateLimit} | ${e.status} | ${e.summary} |`,
    );
  }
  return lines.join('\n');
}
