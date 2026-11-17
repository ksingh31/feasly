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

import type { Permission } from '../auth/permissions';

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
  /**
   * auth/04: permissions the route enforces via `requirePermission`.
   * Empty = no permission check (public routes, or routes where the
   * credential mechanism — magic token, API-key scopes, Stripe signature —
   * IS the authorization). Every entry must declare this explicitly; a
   * conformance test fails CI when one is missing.
   */
  readonly permissions: readonly Permission[];
  /**
   * auth/03: alternative permissions — the caller needs ANY ONE of these
   * (OR), in addition to ALL of `permissions` (AND). For routes two
   * different roles may call under different permission strings (staff
   * `users:manage` vs builder `builder:users:manage`); the route then
   * applies role-specific scoping on top. Optional; validated as known
   * permission strings by the conformance test.
   */
  readonly permissionsAnyOf?: readonly Permission[];
  /**
   * #730: dangerous action — the session's sign-in must be no older than
   * SESSION_REAUTH_WINDOW_SECONDS (401 REAUTH_REQUIRED otherwise). Only
   * valid on session routes that declare permissions (conformance test).
   */
  readonly recentAuth?: true;
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
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary: 'Liveness + dependency checks (2s DB timeout).',
  },

  // ── Public v1: consumer funnel ────────────────────────────────────
  {
    method: 'POST',
    path: '/api/v1/estimate',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '20/hr per IP · 600/hr per tenant (embed; #737, 10× launch target)',
    status: 'live',
    summary:
      'Run a cost estimate (deterministic engine). Public for the web funnel; ' +
      'agent/MCP callers send an API key.',
  },
  {
    method: 'POST',
    path: '/api/v1/estimates/preview',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '20/hr per IP',
    status: 'live',
    summary:
      'Pre-gate estimate preview (same deterministic engine as /estimate; ' +
      'real figures — UI renders them blurred pre-gate — rows empty).',
  },
  {
    method: 'POST',
    path: '/api/v1/leads',
    auth: 'none',
    permissions: [] as const,
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
    permissions: [] as const,
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
    permissions: [] as const,
    rateLimit: '60s cooldown · 5 sends/hr per email · 100/min per IP',
    status: 'live',
    summary:
      'Idempotent "resend my link". Unknown emails get the same response ' +
      '(no enumeration oracle).',
  },
  {
    method: 'GET',
    path: '/api/v1/reports/{reportToken}',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'Resolve a report snapshot by token (immutable shared snapshot; ' +
      'see report redesign). Token IS the credential.',
  },
  {
    method: 'POST',
    path: '/api/v1/reports/{reportToken}/revisions',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '20/hr per IP',
    status: 'live',
    summary:
      'Tier/sqft what-if: recompute through the deterministic engine and ' +
      'append a new immutable report snapshot version. Token IS the credential.',
  },
  {
    method: 'POST',
    path: '/api/v1/callbacks',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '10/min per IP',
    status: 'live',
    summary:
      'Record a callback request (name/phone/preferred window) for a report ' +
      'lead. Token IS the credential.',
  },
  {
    method: 'POST',
    path: '/api/v1/waitlist',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '10/min per IP',
    status: 'live',
    summary:
      'Join a "tell me when it\'s ready" waitlist (renovation, Toronto, ' +
      'Vancouver). Idempotent per (email, topic); never reveals membership.',
  },
  {
    method: 'POST',
    path: '/api/v1/shares',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '10/min per IP',
    status: 'live',
    summary:
      'Email a report to a partner: mints a fresh partner-share magic link ' +
      '(never the owner token) and records the audit row. Token IS the credential. ' +
      'Abuse limits: max 5 shares per estimate per day; partner email must ' +
      'differ from the owner\'s email.',
  },
  {
    method: 'GET',
    path: '/api/v1/shares/verify',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'Verify a partner-share link token (?token=). Partner-share tokens ' +
      'only — owner tokens answer invalid here. Token IS the credential.',
  },
  {
    method: 'POST',
    path: '/api/v1/shares/link',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '10/min per IP',
    status: 'live',
    summary:
      'Create a link-only report share (#838): a fresh read-only partner-share ' +
      'link (never the owner token) that expires after SHARE_LINK_TTL_SECONDS. ' +
      'Owner token in the body IS the credential; partner tokens 403. Max ' +
      'SHARE_LINK_MAX_ACTIVE live links per report.',
  },
  {
    method: 'POST',
    path: '/api/v1/shares/link/list',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '10/min per IP',
    status: 'live',
    summary:
      'List the owner\'s link shares with active/expired/revoked status (#838). ' +
      'Owner token in the body IS the credential.',
  },
  {
    method: 'POST',
    path: '/api/v1/shares/link/revoke',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '10/min per IP',
    status: 'live',
    summary:
      'Revoke one of the owner\'s link shares (#838) — the link stops opening ' +
      'the report immediately. Owner token in the body IS the credential.',
  },

  // ── Public v1: property data ──────────────────────────────────────
  {
    method: 'GET',
    path: '/api/v1/properties/autocomplete',
    auth: 'none',
    permissions: [] as const,
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
    permissions: [] as const,
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
    permissions: [] as const,
    rateLimit: '300/min per IP (dedicated analytics limiter)',
    status: 'live',
    summary:
      'First-party analytics ingest (consent-gated funnel events). Payloads ' +
      'require a valid consent_ts.',
  },
  {
    method: 'POST',
    path: '/api/v1/telemetry',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '10/min per IP (dedicated telemetry limiter)',
    status: 'live',
    summary:
      'Real-user monitoring beacon (#830): sampled Core Web Vitals and JS ' +
      'errors, no PII. Written to App Insights traces, never stored.',
  },
  {
    method: 'GET',
    path: '/api/v1/privacy/export',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary: 'PIPEDA data export for the token holder.',
  },
  {
    method: 'POST',
    path: '/api/v1/privacy/erase-requests',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '10/min per IP',
    status: 'live',
    summary: 'Request erasure; returns a requestId for confirmation.',
  },
  {
    method: 'POST',
    path: '/api/v1/privacy/erase-requests/{requestId}/confirm',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '10/min per IP',
    status: 'live',
    summary: 'Confirm an erasure request (second factor via email link).',
  },
  {
    method: 'POST',
    path: '/api/v1/estimates/{estimateId}/narrative',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'Report narrative for an estimate: the stored monthly community ' +
      'narrative plus a deterministic estimate sentence (#759). No LLM call ' +
      'per request; figures are deterministic.',
  },
  {
    method: 'GET',
    path: '/api/v1/unsubscribe/{token}',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary: 'Unsubscribe landing state (token IS the credential).',
  },
  {
    method: 'POST',
    path: '/api/v1/unsubscribe/{token}',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '10/min per IP',
    status: 'live',
    summary: 'Record the opt-out (CASL).',
  },

  // ── Public v1: content / embed / docs ─────────────────────────────
  {
    method: 'GET',
    path: '/api/v1/communities/{slug}/stats',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary: 'Prerendered community page statistics (SEO content engine).',
  },
  {
    method: 'GET',
    path: '/api/v1/communities/{slug}/lots',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'Community lot inventory (#691): vacant residential lots in an ' +
      'established infill community, derived weekly from City open data. ' +
      'Filters kind/district/minLotSqft/maxLotSqft, sort, cursor pagination; ' +
      'refreshedAt + stale flag. City-assessed value only; no owner names.',
  },
  {
    method: 'GET',
    path: '/api/v1/communities/{slug}/living',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'Living nearby for an established community (#777): nearest + counts ' +
      'within 500 m / 1 km per amenity category, and public-tree cover. ' +
      'Served from monthly-refreshed City open data; never calls a provider.',
  },
  {
    method: 'GET',
    path: '/api/v1/city-data/freshness',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'City of Calgary assessment dataset freshness (landing trust strip): ' +
      '"Refreshed <Month Year>" from the Socrata dataset metadata ' +
      '(rowsUpdatedAt). 24h in-memory cache on successful fetches; ' +
      'Socrata failure answers 200 { refreshedMonth: null } (never 5xx).',
  },
  {
    method: 'GET',
    path: '/api/v1/zoning/districts',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'Zoning rules catalogue for the configured city (#687): district → ' +
      'typical building forms + key rules (height, coverage, density) with ' +
      'bylaw sections; verified values only. Cache-Control public.',
  },
  {
    method: 'GET',
    path: '/api/v1/schools',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'Schools directory (#774): every Calgary K–12 school with type, board, ' +
      'grades, programs, address, coordinates, website and tuition flag; ' +
      'optional ?community= and ?type= filters. Per-field source attribution. ' +
      'Served from our tables (monthly refresh) — never an outside call.',
  },
  {
    method: 'GET',
    path: '/api/v1/schools/{id}',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary: 'One school from the schools directory (#774), with per-field source attribution; 404 when unknown.',
  },
  {
    method: 'GET',
    path: '/api/v1/communities/{slug}/school-designations',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'School designations (#775): CBE + CCSD schools typically designated for ' +
      'an established community per grade band (K–6/K–9, 7–9, 10–12), each with ' +
      "the board's address lookup link; 404 when the community is not covered. " +
      'Served from our tables (monthly refresh) — never an outside call.',
  },
  {
    method: 'GET',
    path: '/api/v1/school-designations',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'School designations for an address (#775), via its community: always ' +
      'labelled "typically designated" and always with each board\'s address ' +
      'lookup link. ?addressKey= required; property lookup reads the shared cache.',
  },
  {
    method: 'GET',
    path: '/api/v1/partners',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'Builder partner disclosure (#888): active builder companies that ' +
      'receive leads from Feasly\'s own site, in display order (name, logo, ' +
      'website, description; no contact details). Cached; Cache-Control public.',
  },
  {
    method: 'GET',
    path: '/api/v1/embed/config',
    auth: 'none',
    permissions: [] as const,
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
    permissions: [] as const,
    rateLimit: '30/min per tenant key',
    status: 'planned',
    summary:
      'Exchange a single-use embed relay code for a 12h session token ' +
      '(embed/06). Replays/expired → 410.',
  },
  {
    method: 'POST',
    path: '/api/v1/embed/relay/resend',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '60s per code · 30/min per IP',
    status: 'live',
    summary:
      'Re-issue a fresh relay code for an expired/used one (embed/06 ' +
      'AC3 — the "session expired" re-issue affordance). 410 on ' +
      'unknown/still-valid codes; 429 inside the 60s per-code cooldown.',
  },
  {
    method: 'POST',
    path: '/api/v1/chat/ask',
    auth: 'none',
    permissions: [] as const,
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
    permissions: [] as const,
    rateLimit: '100/min per IP (1h cache)',
    status: 'live',
    summary: 'Generated OpenAPI 3.1 spec (api-mcp/03). No auth by design.',
  },

  // ── Admin v1 (session cookie; interim X-Admin-Key) ────────────────
  {
    method: 'GET',
    path: '/api/v1/admin/auth/me',
    auth: 'admin',
    permissions: [] as const,
    rateLimit: '100/min per session',
    status: 'planned',
    summary: 'Return the current admin session identity (email).',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/auth/logout',
    auth: 'admin',
    permissions: [] as const,
    rateLimit: '10/min per session',
    status: 'planned',
    summary: 'Revoke the admin session; clears the session cookie.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/auth/entra/callback',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '10/15min per IP',
    status: 'live',
    summary:
      'Entra PKCE callback: exchange the code, validate the id_token ' +
      '(JWKS, aud, iss, exp), resolve/link the user row, mint a 12-hour ' +
      'admin session. Unknown account → 403, no enumeration.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/view-as',
    auth: 'admin',
    permissions: ['view_as'] as const,
    recentAuth: true,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Activate view-as (`{ builderId }` or `{ userId }`): the session ' +
      'resolves permissions + tenant scoping to the target\u2019s view. ' +
      'Admin targets (staff admin/super_admin, any builder_admin) are ' +
      'rejected 403; audit-logged under the real admin\u2019s identity.',
  },
  {
    method: 'DELETE',
    path: '/api/v1/admin/view-as',
    auth: 'admin',
    permissions: [] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Exit view-as on the session. Session-only (exiting can never ' +
      'escalate); audit-logged.',
  },
  // ── Admin user management (auth/03) ───────────────────────────────
  // Admin redesign — ⌘K global search across leads, invoices, builders, users.
  {
    method: 'GET',
    path: '/api/v1/admin/search',
    auth: 'admin',
    permissions: ['leads:read'] as const,
    rateLimit: '60/min per session + 300/min per IP (dedicated search limiters)',
    status: 'live',
    summary:
      'Global admin search: typed hits (lead, invoice, builder, user) with ' +
      'display labels and IDs. Staff only; each kind gated by its own ' +
      'read permission.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/users',
    auth: 'admin',
    permissions: [] as const,
    permissionsAnyOf: ['users:manage', 'builder:users:manage'] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Paginated user list with builder memberships (admin user ' +
      'management). Builder admins see only their own orgs.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/users/invite',
    auth: 'admin',
    permissions: [] as const,
    permissionsAnyOf: ['users:manage', 'builder:users:manage'] as const,
    rateLimit: '20/min per session',
    status: 'live',
    summary:
      'Invite a user by email: Graph account + invitation row + branded ' +
      'email. Staff may grant any role; builder admins only builder roles ' +
      'into their own orgs (cross-builder → 403).',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/users/{id}',
    auth: 'admin',
    permissions: [] as const,
    permissionsAnyOf: ['users:manage', 'builder:users:manage'] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary: 'One user with builder memberships. Builder admins: own orgs only.',
  },
  {
    method: 'PATCH',
    path: '/api/v1/admin/users/{id}',
    auth: 'admin',
    permissions: [] as const,
    permissionsAnyOf: ['users:manage', 'builder:users:manage'] as const,
    recentAuth: true,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Update name, staff role, status (deactivate revokes sessions), or ' +
      'memberships. Builder admins are scoped to their own orgs and ' +
      'cannot touch staff roles.',
  },
  {
    method: 'DELETE',
    path: '/api/v1/admin/users/{id}',
    auth: 'admin',
    permissions: ['users:manage'] as const,
    recentAuth: true,
    rateLimit: '20/min per session',
    status: 'live',
    summary:
      'Hard delete — only users who never accepted (status invited); ' +
      'anyone who signed in is deactivated via PATCH instead. Deletes ' +
      'the Graph account first. Protected/self/last-super_admin guarded.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/users/{id}/resend-invite',
    auth: 'admin',
    permissions: [] as const,
    permissionsAnyOf: ['users:manage', 'builder:users:manage'] as const,
    rateLimit: '20/min per session',
    status: 'live',
    summary:
      'Re-issue a pending invitation (retries the Graph account create ' +
      'when the first attempt failed). Same scoping as invite.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/auth/switch-builder',
    auth: 'admin',
    permissions: [] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Switch the session\u2019s active builder (org switcher). The builder ' +
      'must be one of the caller\u2019s memberships — anything else is ' +
      '403, never honored. Audit-logged.',
  },
  // ── Builder v1 (session cookie; embed/09) ──────────────────────────
  {
    method: 'POST',
    path: '/api/v1/builder/auth/request',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '5 sends/hr per email · 100/min per IP',
    status: 'live',
    summary:
      'Request a builder magic link. Identical response for allowlisted and ' +
      'non-allowlisted emails (no enumeration oracle).',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/auth/verify',
    auth: 'magic-token',
    permissions: [] as const,
    rateLimit: '10/min per IP',
    status: 'live',
    summary:
      'Consume the builder magic link (?token=…) → httpOnly Secure SameSite=None ' +
      'session cookie (cross-origin: SWA Free SKU has no linked backend), 7-day expiry. Single-use (replay-safe).',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/auth/me',
    auth: 'builder-session',
    permissions: [] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary: 'Return the current builder session identity (email + tenant).',
  },
  {
    method: 'POST',
    path: '/api/v1/builder/auth/logout',
    auth: 'builder-session',
    permissions: [] as const,
    rateLimit: '10/min per session',
    status: 'live',
    summary: 'Revoke the builder session; clears the session cookie.',
  },
  // ── Builder v1 — Entra org accounts (auth/05) ──────────────────────
  {
    method: 'POST',
    path: '/api/v1/builder/auth/entra/callback',
    auth: 'none',
    permissions: [] as const,
    rateLimit: '10/15min per IP',
    status: 'live',
    summary:
      'Builder Entra sign-in callback. Exchanges the PKCE code, resolves ' +
      'the user\u2019s builder memberships (not staff roles), and mints a ' +
      'builder session bound to the user id + active builder. 503 while ' +
      'the builder Entra app is unprovisioned.',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/auth/memberships',
    auth: 'builder-session',
    permissions: [] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'List the caller\u2019s org memberships with the session\u2019s active builder.',
  },
  {
    method: 'POST',
    path: '/api/v1/builder/auth/active-org',
    auth: 'builder-session',
    permissions: [] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Switch the session\u2019s active builder (org switcher). The builder ' +
      'must be one of the caller\u2019s memberships — anything else is 403, ' +
      'never honored. Audit-logged.',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/users',
    auth: 'builder-session',
    permissions: ['builder:users:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'List users holding a membership in the session\u2019s active org. ' +
      'Builder-admin only.',
  },
  {
    method: 'POST',
    path: '/api/v1/builder/view-as',
    auth: 'builder-session',
    permissions: ['view_as'] as const,
    recentAuth: true,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Builder-side view-as (2026-09-30, Karan): a builder_admin views the ' +
      'portal as a regular team member of their own org. Targets are ' +
      'userId-only, org-scoped, and never admins (#394 lockdown). ' +
      'Audit-logged under the real builder admin\u2019s identity.',
  },
  {
    method: 'DELETE',
    path: '/api/v1/builder/view-as',
    auth: 'builder-session',
    permissions: [] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Exit builder-side view-as on the session. Session-only (exiting ' +
      'can never escalate — the borrowed view strips `view_as`); ' +
      'audit-logged.',
  },
  {
    method: 'POST',
    path: '/api/v1/builder/users/invite',
    auth: 'builder-session',
    permissions: ['builder:users:manage'] as const,
    rateLimit: '20/min per session',
    status: 'live',
    summary:
      'Invite a team member into the session\u2019s active org (builder ' +
      'roles only; the org comes from the session, never the request). ' +
      'Builder-admin only.',
  },
  {
    method: 'PATCH',
    path: '/api/v1/builder/users/{id}',
    auth: 'builder-session',
    permissions: ['builder:users:manage'] as const,
    recentAuth: true,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Rename / change org role / activate / disable an org user. ' +
      'Disabling kills the user\u2019s builder sessions immediately. ' +
      'Builder-admin only.',
  },
  {
    method: 'POST',
    path: '/api/v1/builder/users/{id}/resend-invite',
    auth: 'builder-session',
    permissions: ['builder:users:manage'] as const,
    rateLimit: '20/min per session',
    status: 'live',
    summary:
      'Re-issue a pending invitation for a member of the session\u2019s ' +
      'active org who never accepted (retries the Graph account when the ' +
      'first attempt failed). Builder-admin only.',
  },
  {
    method: 'DELETE',
    path: '/api/v1/builder/users/{id}',
    auth: 'builder-session',
    permissions: ['builder:users:manage'] as const,
    recentAuth: true,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Remove a user from the session\u2019s active org (membership ' +
      'revoked; row disabled when it\u2019s the last membership). Sessions ' +
      'revoked immediately. Builder-admin only.',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/leads',
    auth: 'builder-session',
    permissions: ['builder:leads:read'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'List the builder\'s leads (tenant-scoped, newest first) with a ' +
      'pipeline summary (new/contacted/quoted/won/lost).',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/leads/needs-you',
    auth: 'builder-session',
    permissions: ['builder:leads:read'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Leads home "Needs you" feed (tenant-scoped): uncontacted, stale ' +
      '(no status change in LEAD_NEEDS_YOU_STALE_DAYS+ days) and won ' +
      'without a recorded contract, each sorted by score then age, plus ' +
      'status counts for the segmented filter.',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/notifications/preferences',
    auth: 'builder-session',
    permissions: ['builder:leads:read'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Signed-in builder member reads their email notification preferences ' +
      '(#725): new-lead email (default on), daily "Needs you" digest ' +
      '(default off), billing email (default on, admins only), their org ' +
      'role, and whether they may turn billing emails off.',
  },
  {
    method: 'PUT',
    path: '/api/v1/builder/notifications/preferences',
    auth: 'builder-session',
    permissions: ['builder:leads:read'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Signed-in builder member updates their email notification ' +
      'preferences (#725, partial body). 409 LAST_ADMIN when the org\'s ' +
      'last admin receiving billing emails turns them off; 403 while ' +
      'viewing as a teammate.',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/profile',
    auth: 'builder-session',
    permissions: ['builder:leads:read'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Builder org profile & branding (#870): display name, contact ' +
      'email/phone, logo URL, accent colour, the support contact (email, ' +
      'promised response time) and canEdit (org owners only). Never rate, ' +
      'plan or status.',
  },
  {
    method: 'PUT',
    path: '/api/v1/builder/profile',
    auth: 'builder-session',
    permissions: ['builder:settings:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Org owner updates profile & branding (#870, partial body): display ' +
      'name, contact email/phone, https logo URL, #rrggbb accent colour. ' +
      'Audit-logged under the acting user; 403 for members and while ' +
      'viewing as a teammate.',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/embed',
    auth: 'builder-session',
    permissions: ['builder:leads:read'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Embed install data (#870): tenant key, loader URL + snippet, ' +
      'allowed origins (read-only) with each origin\'s last embed_loaded ' +
      'and whether it loaded within the live window (default 7 days), plus ' +
      'open origin-change requests.',
  },
  {
    method: 'POST',
    path: '/api/v1/builder/embed/origin-requests',
    auth: 'builder-session',
    permissions: ['builder:settings:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Org owner asks Feasly staff to add/remove allowed embed origins ' +
      '(#870; staff-controlled for the pilot). Creates exactly one admin ' +
      'task (an identical open request returns created: false) and emails ' +
      'the team inbox. Audit-logged.',
  },
  {
    method: 'POST',
    path: '/api/v1/builder/account/close-request',
    auth: 'builder-session',
    permissions: ['builder:settings:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Org owner asks Feasly to close the builder account (#860). Creates ' +
      'one open admin task per builder (a repeat returns created: false) ' +
      'and emails the team inbox. No self-serve deletion. Audit-logged.',
  },
  {
    method: 'PATCH',
    path: '/api/v1/builder/leads/{id}',
    auth: 'builder-session',
    permissions: ['builder:leads:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Transition a builder lead\'s pipeline status. 403 when the lead ' +
      'belongs to a different tenant. A transition to "won" runs the ' +
      'billing/01 charge path: with contractValueCents + contractSignedAt ' +
      'it creates the draft commission invoice (auto-submitted into ' +
      'review); without them the invoice waits for ' +
      'POST /api/v1/billing/report-contract. Contract details additionally ' +
      'require builder:billing (403 for builder members).',
  },
  {
    method: 'POST',
    path: '/api/v1/builder/leads/{id}/mark-won',
    auth: 'builder-session',
    permissions: ['builder:leads:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Mark a builder lead won without recording the contract (any org ' +
      'member). The lead shows as "Needs recording" and the org\'s admins ' +
      'are emailed to record the signed contract. 409 when a contract is ' +
      'already recorded; idempotent for already-won leads.',
  },
  // ── billing/05 lead comments ────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/v1/builder/leads/{leadId}/comments',
    auth: 'builder-session',
    permissions: ['builder:leads:read'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Lead comment thread for the builder portal — `org`-visible comments ' +
      'only. `admin_only` rows are excluded in SQL, never serialized.',
  },
  {
    method: 'POST',
    path: '/api/v1/builder/leads/{leadId}/comments',
    auth: 'builder-session',
    permissions: ['builder:leads:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Add a builder comment to a lead. Visibility is forced to `org` ' +
      'server-side; any client-sent visibility is ignored.',
  },
  {
    method: 'PATCH',
    path: '/api/v1/builder/comments/{commentId}',
    auth: 'builder-session',
    permissions: ['builder:leads:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      "Edit the builder's own comment (author-only). There is no builder " +
      'DELETE route — builders cannot delete comments.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/leads/{leadId}/comments',
    auth: 'admin',
    permissions: ['leads:read'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Full lead comment thread for admins, including `admin_only` rows.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/leads/{leadId}/comments',
    auth: 'admin',
    permissions: ['leads:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Add an admin comment to a lead. Defaults to `admin_only` unless ' +
      '`org` is explicitly requested.',
  },
  {
    method: 'PATCH',
    path: '/api/v1/admin/comments/{commentId}',
    auth: 'admin',
    permissions: ['leads:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary: "Edit an admin's own comment (author-only).",
  },
  {
    method: 'DELETE',
    path: '/api/v1/admin/comments/{commentId}',
    auth: 'admin',
    permissions: ['leads:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Soft-delete a comment (admin moderation). The row survives in the ' +
      'database; both read paths exclude it in SQL.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/api-keys',
    auth: 'admin',
    permissions: ['api_keys:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary: 'List API keys (masked, paginated).',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/api-keys',
    auth: 'admin',
    permissions: ['api_keys:manage'] as const,
    recentAuth: true,
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
    permissions: ['api_keys:manage'] as const,
    recentAuth: true,
    rateLimit: '10/min per session',
    status: 'live',
    summary: 'Rotate a key (old key stays valid for a grace window).',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/api-keys/{id}/revoke',
    auth: 'admin',
    permissions: ['api_keys:manage'] as const,
    rateLimit: '10/min per session',
    status: 'live',
    summary: 'Revoke a key immediately. Audit-logged.',
  },
  {
    method: 'PATCH',
    path: '/api/v1/admin/api-keys/{id}',
    auth: 'admin',
    permissions: ['api_keys:manage'] as const,
    rateLimit: '10/min per session',
    status: 'live',
    summary:
      'Update a key\u2019s scopes and/or rate limit (api-mcp/02). Takes effect ' +
      'on the next request. Audit-logged.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/leads',
    auth: 'admin',
    permissions: ['leads:read'] as const,
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
    permissions: ['leads:read'] as const,
    rateLimit: '300/min per session',
    status: 'planned',
    summary: 'Lead detail: estimate summary, timeline, consent, attribution.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/leads/{id}/notes',
    auth: 'admin',
    permissions: ['leads:manage'] as const,
    rateLimit: '60/min per session',
    status: 'planned',
    summary: 'Append-only lead notes.',
  },
  {
    method: 'PATCH',
    path: '/api/v1/admin/leads/{id}/status',
    auth: 'admin',
    permissions: ['leads:manage'] as const,
    rateLimit: '60/min per session',
    status: 'planned',
    summary:
      'Lead status (new/contacted/quoting/won/lost). Writes ' +
      'lead_status_history; audit-logged.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/leads/{id}/quarantine/approve',
    auth: 'admin',
    permissions: ['leads:manage'] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Approve a quarantined lead: clears the honeypot/quarantine flag ' +
      '(and any discard flag); the lead returns to the normal pipeline. ' +
      '422 when the lead is not quarantined; audit-logged.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/leads/{id}/quarantine/discard',
    auth: 'admin',
    permissions: ['leads:manage'] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Discard a quarantined lead: kept for audit, excluded from every ' +
      'listing and count. 422 when the lead is not quarantined; ' +
      'idempotent; audit-logged.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/leads/export.csv',
    auth: 'admin',
    permissions: ['leads:read'] as const,
    rateLimit: '10/min per session',
    status: 'planned',
    summary: 'CSV export of the filtered lead set.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/audit',
    auth: 'admin',
    permissions: ['audit:read'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Audit log viewer (#728): admin_audit_log + billing_events merged, ' +
      'newest first, keyset cursor (limit 1–100, default 50). Filters: ' +
      'actor, action prefix, entity type/id, from/to, impersonation only, ' +
      'source. Entries carry actor, time, entity link and before/after ' +
      'detail.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/leads/{id}/assign-builder',
    auth: 'admin',
    permissions: ['leads:assign'] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Assign a lead to a builder (builders table) by builder id, or ' +
      'unassign with builderId null. Null is the default and never ' +
      'affects the lead flow. 404 for unknown lead or builder; ' +
      'audit-logged with ids only, no contact PII.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/builders',
    auth: 'admin',
    permissions: ['builders:read'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'List all builders (builders table): id, tenant_key, names, ' +
      'contact, plan, status, settings.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/builders',
    auth: 'admin',
    permissions: ['builders:manage'] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Create a builder. tenant_key is unique (409 on conflict); ' +
      'audit-logged with ids only, no contact PII.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/builders/{id}',
    auth: 'admin',
    permissions: ['builders:read'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary: 'Get one builder by id. 404 when unknown.',
  },
  {
    method: 'PATCH',
    path: '/api/v1/admin/builders/{id}',
    auth: 'admin',
    permissions: ['builders:manage'] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Update a builder. tenant_key is immutable; 404 when unknown; ' +
      'audit-logged with ids only, no contact PII.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/builders/{id}/status',
    auth: 'admin',
    permissions: ['builders:manage'] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Builder lifecycle action (#860): suspend, reactivate, ' +
      'start_offboarding or complete_offboarding, with a mandatory reason. ' +
      'Complete is refused (409 OFFBOARDING_BLOCKED) while an invoice is ' +
      'unpaid or a dispute is open; on success it revokes sessions and API ' +
      'keys and detaches the card. Audit-logged with the admin identity.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/builders/{id}/offboarding-blockers',
    auth: 'admin',
    permissions: ['builders:manage'] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'What blocks "complete offboarding" for one builder right now (#861): ' +
      'unpaid invoices and open disputes, each naming the invoice. Empty ' +
      'list = nothing blocks. Read-only; drives the admin offboarding checklist.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/builders/{id}/export.csv',
    auth: 'admin',
    permissions: ['builders:manage'] as const,
    rateLimit: '10/min per session',
    status: 'live',
    summary:
      'CSV hand-over export of one builder\'s leads (kind=leads) or ' +
      'invoices (kind=invoices) (#860). Audit-logged with row counts only.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/partners',
    auth: 'admin',
    permissions: ['builders:read'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary: 'List every builder partner (#888), active and inactive, in display order.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/partners',
    auth: 'admin',
    permissions: ['builders:manage'] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Add a builder partner (#888): name, https logo/website, description, ' +
      'optional builder link, display order, active. Audit-logged (ids only).',
  },
  {
    method: 'PATCH',
    path: '/api/v1/admin/partners/{id}',
    auth: 'admin',
    permissions: ['builders:manage'] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Edit, deactivate (active=false) or reorder (displayOrder) a builder ' +
      'partner (#888). 404 when unknown; audit-logged (ids + field names).',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/estimates/{id}',
    auth: 'admin',
    permissions: ['estimates:read'] as const,
    rateLimit: '300/min per session',
    status: 'planned',
    summary: 'Estimate lookup for support/debugging.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/estimates/{id}/narrative',
    auth: 'admin',
    permissions: ['estimates:read'] as const,
    rateLimit: '60/min per session',
    status: 'live',
    summary:
      'Report narrative for an estimate (stored community narrative + ' +
      'deterministic estimate sentence, #759). Same read path as the consumer ' +
      'endpoint, but Entra admin-session-gated; no LLM call per request.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/funnels',
    auth: 'admin',
    permissions: ['analytics:read'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary: 'Funnel dashboards (admin/07): step drop-off, gate conversion.',
  },
  // ── Billing admin (billing/03 follow-on, was OPS-007) ──────────────
  {
    method: 'GET',
    path: '/api/v1/admin/billing',
    auth: 'admin',
    permissions: ['billing:read'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Billing-health dashboard (billing/03): MRR (flat model; null under ' +
      'the 1% commission model), trailing-30d commission collections, ' +
      'in-review invoice aging buckets (<48h / <7d / overdue), disputed ' +
      'totals, the dunning queue with past_due_since, and Stripe webhook ' +
      'health. Read-only — no charge/refund/void actions.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/billing/invoices/{id}/retry',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Retry a failed commission charge (BILL-03): new off-session ' +
      'PaymentIntent with idempotency key ' +
      'feasly:commission_invoices:{id}:retry:{n}, invoice failed → ' +
      'finalized (review window NOT reopened). Failed-only (409 ' +
      'otherwise), disputed never retried, ' +
      'capped by BILLING_MAX_CHARGE_RETRIES.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/billing/invoices/{id}/dunning',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Edit one invoice\'s retry schedule (#718): pause, resume or cancel ' +
      'automatic retries and reminders, or set the grace period (1–90 ' +
      'days; the next retry is rescheduled from the last failure). 409 on ' +
      'paid, void or disputed invoices. Audited with the admin email.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/billing/simulated/invoices/{id}/events',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Test mode only (#753): fire a dispute, dashboard refund (full or ' +
      "partial) or delayed failure against an invoice's simulated " +
      'PaymentIntent; the Stripe-shaped event goes through the production ' +
      'webhook handler. 404 unless the simulated payment provider is active.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/billing/invoices/{id}/mark-paid',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    recentAuth: true,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Admin records an off-Stripe payment (cheque | bank_draft | ' +
      'e_transfer | cash | card_terminal | other) with an optional ' +
      'cheque/trace reference and paid date. Marks the invoice paid and ' +
      'cancels the scheduled auto-charge — the builder can never be ' +
      'double-charged. Allowed from in_review / failed only: a finalized ' +
      'invoice owns an in-flight Stripe PaymentIntent that cannot be ' +
      'cancelled here, so it 409s (mark paid after the charge fails, or ' +
      'refund first). Disputed and settled invoices 409. Audited with ' +
      'the admin identity.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/billing/invoices/{id}/commission-rate',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Admin overrides the per-invoice commission rate (percent, ' +
      '0 < rate <= 10) and recalculates the invoice amount. Unpaid ' +
      'invoices only (draft, in_review, disputed): settled (paid/void) ' +
      'and failed invoices are never repriced (409), and a finalized ' +
      'invoice with a charge in flight is blocked too. Audited old → ' +
      'new rate with the admin identity.',
  },
  {
    method: 'PUT',
    path: '/api/v1/admin/billing/invoices/{id}/payment-method',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Admin changes the planned payment method on one commission ' +
      'invoice (card | cheque | e_transfer | bank_draft). Unpaid invoices ' +
      'only (draft, in_review, failed — 409 otherwise). Choosing a manual ' +
      'method pauses the Stripe auto-charge until staff marks the invoice ' +
      'paid. Same service path as the builder endpoint; audited with the ' +
      'admin identity.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/billing/invoices/{id}/refund',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Admin refunds a paid commission invoice in full or in part (#715). ' +
      'Card-paid invoices are refunded on the payment provider (idempotency ' +
      'key feasly:commission_invoices:{id}:refund:{idempotencyKey}); ' +
      'manually paid invoices record an off-Stripe refund with a reference. ' +
      'Same idempotencyKey = same refund, never a second one. 409 unless ' +
      'paid; 422 past the amount left to refund. The invoice stays paid ' +
      '(refundState partially_refunded / refunded). Audited with the admin ' +
      'identity.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/billing/invoices/{id}/void',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Admin voids a commission invoice that must not be charged (#715). ' +
      'Allowed from draft, in_review and failed; 409 from finalized ' +
      '(charge in flight), paid (refund instead), disputed (dispute ' +
      'console) and void. The review clock is cleared, so the reviewer ' +
      'timer never charges it. Audited with the admin identity.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/billing/invoices/{id}/correct-contract',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Admin corrects the reported contract (value excl. land, signed ' +
      'date, mandatory note) on a draft or in_review invoice (#715; 409 ' +
      'otherwise). Commission and tax are recalculated at the invoice\'s ' +
      'own rate and tax snapshot; an in_review invoice restarts its 7-day ' +
      'review window and the builder is emailed. Original values stay in ' +
      'the audit trail.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/billing/invoices/{id}/reverse-payment',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Admin reverses a manual mark-paid (bounced cheque) with a mandatory ' +
      'reason (#715): paid → failed. Manually paid invoices with no ' +
      'refunds only (409 otherwise); the planned payment method is kept, ' +
      'so nothing is auto-charged. Audited with the admin identity.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/billing/invoices',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Admin manually creates a commission invoice for a builder\'s ' +
      'converted lead. Mirrors the builder-reported contract shape ' +
      '(leadId, contractValueCents excl. land, ISO contractSignedAt with ' +
      'offset) plus tenantKey. Same charge path: 12-month attribution → ' +
      'draft invoice → auto-submitted into the 7-day review window. ' +
      'Idempotent: re-reporting returns the existing invoice.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/billing/summary',
    auth: 'admin',
    permissions: ['finance:export'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Finance summary for [from, to) (#728; default the current month, ' +
      'max FINANCE_MAX_RANGE_DAYS): invoiced, collected, refunded, ' +
      'outstanding and tax in integer cents, total and by builder. ' +
      'Computed from stored invoice amounts; matches the invoice CSV for ' +
      'the same period to the cent.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/billing/invoices/export.csv',
    auth: 'admin',
    permissions: ['finance:export'] as const,
    rateLimit: '10/min per session',
    status: 'live',
    summary:
      'Invoice CSV for [from, to) (#728), every builder or one ' +
      '(tenantKey): number, builder, lead, contract value, rate, ' +
      'commission, tax, total, status, payment method, paid date, ' +
      'refunded, Stripe PaymentIntent id. Over EXPORT_MAX_ROWS → 422 ' +
      '(never truncated). Audit-logged.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/community-stats/refresh',
    auth: 'admin',
    permissions: ['ops:manage'] as const,
    rateLimit: '10/min per session',
    status: 'live',
    summary:
      'Manually trigger the community-stats refresh (neighbourhood/05). ' +
      'Audit-logged.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/neighbourhood-data/{provider}/refresh',
    auth: 'admin',
    permissions: ['ops:manage'] as const,
    rateLimit: '10/min per session',
    status: 'live',
    summary:
      'Run one neighbourhood data provider refresh now (#773): ' +
      'school-directory, school-designation, school-ratings, reviews, ' +
      'amenities or commute. Keeps the previous data on failure. ' +
      'Audit-logged.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/community-narratives',
    auth: 'admin',
    permissions: ['ops:manage'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Monthly community narratives (#759): each community\'s latest period, ' +
      'status, and generated date.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/community-narratives/regenerate',
    auth: 'admin',
    permissions: ['ops:manage'] as const,
    rateLimit: '10/min per session',
    status: 'live',
    summary:
      'Regenerate the community narrative now — one community or all (#759). ' +
      'Admin-only, audit-logged.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/usage',
    auth: 'admin',
    permissions: ['usage:read'] as const,
    rateLimit: '300/min per session',
    status: 'planned',
    summary: 'Per-key usage metering (api-mcp/07).',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/calibration',
    auth: 'admin',
    permissions: ['calibration:read'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Calibration console (admin/09): current cost-data version, ' +
      'calibration report, import history. Read-only.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/ops/sheets-status',
    auth: 'admin',
    permissions: ['ops:manage'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary: 'Sheets sync worker status (admin/05).',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/ops/jobs',
    auth: 'admin',
    permissions: ['ops:manage'] as const,
    rateLimit: '300/min per session',
    status: 'live',
    summary:
      'Job queue view (#838): per-status counts + latest jobs in one status ' +
      '(?status=, default dead = failed jobs that exhausted retries).',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/ops/sheets-sync-now',
    auth: 'admin',
    permissions: ['ops:manage'] as const,
    rateLimit: '10/min per session',
    status: 'live',
    summary: 'Trigger an immediate Sheets sync (admin/05).',
  },

  // ── Builder portal v1 (builder dashboard sessions) ───────────────
  {
    method: 'GET',
    path: '/api/v1/builder/agreement',
    auth: 'builder-session',
    permissions: ['builder:leads:read'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Platform agreement status for the session\u2019s builder org (#722): ' +
      'current version, whether it is accepted (when, by whom), whether ' +
      'the caller may accept, and the versioned agreement text.',
  },
  {
    method: 'POST',
    path: '/api/v1/builder/agreement/accept',
    auth: 'builder-session',
    permissions: ['builder:leads:read'] as const,
    rateLimit: '10/min per session',
    status: 'live',
    summary:
      'Accept the current platform agreement (clickwrap, #722; was planned ' +
      'with auth none). Builder org admin only \u2014 members get 403 ' +
      'AGREEMENT_ADMIN_REQUIRED; a stale version is 409 ' +
      'AGREEMENT_VERSION_MISMATCH. Append-only record of version, time, ' +
      'user, client IP and user agent.',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/onboarding',
    auth: 'builder-session',
    permissions: ['builder:leads:read'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'First-run onboarding checklist for the session\u2019s builder org ' +
      '(#722): agreement accepted, profile complete, payment method set, ' +
      'embed verified, team invited \u2014 each from real state.',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/leads/{id}',
    auth: 'builder-session',
    permissions: ['builder:leads:read'] as const,
    rateLimit: '300/min per session',
    status: 'planned',
    summary: 'Attributed lead detail (tenant-scoped).',
  },

  // ── MCP server (agent API) ──────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/mcp/v1',
    auth: 'api-key',
    permissions: [] as const,
    rateLimit: '100/min per key · 100/day + 2,000/month per key (config, #738)',
    status: 'live',
    summary:
      'MCP server: Streamable HTTP transport (api-mcp/06). Bearer <redacted> ' +
      'key + per-tool scopes; stateless JSON-RPC.',
  },

  // ── Billing webhooks ──────────────────────────────────────────────
  {
    method: 'POST',
    path: '/api/v1/stripe/webhooks',
    auth: 'stripe-signature',
    permissions: [] as const,
    rateLimit: '100/min per IP',
    status: 'live',
    summary:
      'Stripe webhook receiver (billing track). Signature-verified; ' +
      'idempotent event handling.',
  },
  // ── Billing first charge path (billing/01) ─────────────────────────
  {
    method: 'POST',
    path: '/api/v1/billing/report-contract',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Builder reports the signed construction contract (value excl. land) ' +
      'for one of their leads. Runs the commission charge path: attribution ' +
      '→ draft invoice → auto-submitted into the 7-day review window. ' +
      'Idempotent: re-reporting returns the existing invoice.',
  },
  {
    method: 'POST',
    path: '/api/v1/billing/setup-intent',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Builder creates a SetupIntent to save a card on file (commission ' +
      'model). Idempotent: ensures the tenant\'s Stripe customer first. ' +
      'Returns the client secret for Stripe Elements.',
  },
  // ── Simulated payment provider (#753) — 404 unless PAYMENTS_PROVIDER=simulated
  {
    method: 'POST',
    path: '/api/v1/billing/simulated/confirm-setup',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Test mode only: builder saves one of the Stripe test cards against ' +
      'their SetupIntent (stand-in for Stripe Elements). 3DS cards return ' +
      'requires_action. 404 unless the simulated payment provider is active.',
  },
  {
    method: 'POST',
    path: '/api/v1/billing/simulated/authenticate',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Test mode only: complete or fail the 3D Secure challenge on the ' +
      "builder's SetupIntent / PaymentIntent in requires_action. 404 unless " +
      'the simulated payment provider is active.',
  },
  {
    method: 'GET',
    path: '/api/v1/billing/card',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Builder reads their card-on-file status (brand/last4/expiry only — ' +
      'the PAN never leaves Stripe) plus expiresSoon/expired flags (#716). ' +
      'One card per builder: the newest saved card is the default the ' +
      'charge uses. Commission model.',
  },
  {
    method: 'DELETE',
    path: '/api/v1/billing/card',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Builder admin removes the card on file (#716); 403 for builder ' +
      'members. 409 while an unpaid invoice is set to be charged to the ' +
      'card (switch it to a manual method or save a new card first). ' +
      'Idempotent: no card → hasCard false. Commission model.',
  },
  {
    method: 'GET',
    path: '/api/v1/billing/commission-rate',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Builder reads their org\'s negotiated commission rate (percent), ' +
      'for the "Record signed contract" live preview. Falls back to the ' +
      'configured default when the builder row is missing.',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/billing/overview',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Builder portal Money page header in one call (#531): outstanding ' +
      'total (unpaid, non-disputed invoices), next card auto-charge ' +
      '(amount, date, card last4), failed invoices, plan type + the ' +
      'org\'s configured commission rate (default 1%), and card on file. ' +
      'Tenant-scoped to the builder session.',
  },
  {
    method: 'GET',
    path: '/api/v1/builder/activity',
    auth: 'builder-session',
    permissions: ['builder:activity:read'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Builder org activity history (#728), newest first, keyset cursor. ' +
      'Builder owner/admins (builder:activity:team) see the whole team; ' +
      'other members see only their own actions. Staff security ' +
      'internals are excluded and Feasly staff show as Feasly.',
  },
  {
    method: 'GET',
    path: '/api/v1/billing/payment-method',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Builder reads their org\'s default payment method (billing/12): ' +
      'card (card on file), cheque, e_transfer, or bank_draft. Every new ' +
      'commission invoice is created with this method. \'card\' when the ' +
      'builder never chose one.',
  },
  {
    method: 'PUT',
    path: '/api/v1/billing/payment-method',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Builder sets their org\'s default payment method (billing/12). ' +
      'Applies to invoices created afterwards; existing invoices keep ' +
      'the method they were created with. 400 on an unknown method.',
  },
  {
    method: 'PUT',
    path: '/api/v1/billing/invoices/{id}/payment-method',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Builder changes the payment method on one of their invoices ' +
      '(billing/12). Unpaid invoices only (draft, in_review, failed) — ' +
      '409 otherwise; 403 for another tenant\'s invoice. Choosing a ' +
      'manual method pauses the Stripe auto-charge: the invoice-reviewer ' +
      'timer skips non-card invoices until staff marks them paid.',
  },
  {
    method: 'POST',
    path: '/api/v1/billing/invoices/{id}/confirm-payment',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'SCA recovery (#712): the bank demanded 3-D Secure on the ' +
      'off-session charge, so the invoice is action_required. Returns the ' +
      'PaymentIntent client secret, the card it used and the provider so ' +
      'the builder confirms the payment on-session; the webhook settles ' +
      'the invoice. 409 unless action_required; 403 for another tenant\'s ' +
      'invoice.',
  },
  {
    method: 'POST',
    path: '/api/v1/billing/invoices/{id}/pay',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Pay now (#718): charge a commission invoice whose card payment ' +
      'failed against the card on file right away (new PaymentIntent, ' +
      'idempotency key feasly:commission_invoices:{id}:retry:{n}). Allowed ' +
      'while retries are paused, cancelled or in collections; never changes ' +
      'the schedule. Double submission returns the invoice unchanged — one ' +
      'charge. 409 unless failed; 403 for another tenant\'s invoice.',
  },
  {
    method: 'GET',
    path: '/api/v1/billing/invoices/{id}',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Read a commission invoice. Builders see only their own tenant\'s ' +
      'invoices; admins see all.',
  },
  {
    method: 'GET',
    path: '/api/v1/billing/invoices/{id}/pdf',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Download a commission invoice as a PDF (#661), rendered from the ' +
      'same server figures as the JSON read; paid invoices include the ' +
      'receipt block. Builders get only their own tenant\'s invoices ' +
      '(404 for another tenant\'s id); admins see all.',
  },
  {
    method: 'GET',
    path: '/api/v1/billing/invoices',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'BILL-04: paginated commission invoice list, newest first ' +
      '(limit 1–100, default 20; offset default 0). Builders see only ' +
      'their own tenant\'s invoices; admins see all.',
  },
  {
    method: 'GET',
    path: '/api/v1/billing/invoices/export.csv',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '10/min per session',
    status: 'live',
    summary:
      'Builder downloads their own invoice CSV for [from, to) (#728) for ' +
      'their bookkeeper — same columns as the admin export. Tenant comes ' +
      'from the session; another tenant\'s invoices are never included. ' +
      'Audit-logged.',
  },
  {
    method: 'POST',
    path: '/api/v1/billing/invoices/{id}/dispute',
    auth: 'builder-session',
    permissions: ['builder:billing'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Builder disputes their own invoice (reason required): the charge ' +
      'clock freezes and ops is alerted. 403 for another tenant\'s invoice.',
  },
  {
    method: 'POST',
    path: '/api/v1/billing/invoices/{id}/resolve',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Admin resolves a billing dispute: "resume" returns the invoice to ' +
      'review with a fresh 7-day window, "void" cancels it.',
  },
  // ── Dispute console (billing/01 follow-on, was OPS-009) ─────────────
  {
    method: 'GET',
    path: '/api/v1/admin/disputes',
    auth: 'admin',
    permissions: ['billing:read'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Dispute console: open disputes oldest-first with reason, immutable ' +
      'evidence snapshot reference, and the 5-business-day SLA countdown ' +
      '(America/Edmonton). Admin only.',
  },
  {
    method: 'GET',
    path: '/api/v1/admin/disputes/{id}',
    auth: 'admin',
    permissions: ['billing:read'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'One dispute: immutable evidence snapshot, SLA state, and the ' +
      'billing audit trail. Admin only.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/disputes/{id}/accept',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Accept a dispute: voids the invoice (Stripe refund first when it ' +
      'was already paid — the credit note). Audit-logged. Admin only.',
  },
  {
    method: 'POST',
    path: '/api/v1/admin/disputes/{id}/reject',
    auth: 'admin',
    permissions: ['billing:manage'] as const,
    rateLimit: '100/min per session',
    status: 'live',
    summary:
      'Reject a dispute: the invoice returns to in_review with a fresh ' +
      '7-day window. Audit-logged. Admin only.',
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
    '| Method | Path | Auth | Permissions | Rate limit | Status | Summary |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const e of ROUTE_REGISTRY) {
    // auth/03: permissionsAnyOf (OR) renders alongside permissions (AND).
    const perms = [...e.permissions, ...(e.permissionsAnyOf ?? [])];
    lines.push(
      `| ${e.method} | \`${e.path}\` | ${e.auth} | ${perms.length > 0 ? perms.join(', ') : '\u2014'} | ${e.rateLimit} | ${e.status} | ${e.summary} |`,
    );
  }
  return lines.join('\n');
}

/** Markers delimiting the generated table in docs/security/rate-limits.md (#729). */
export const RATE_LIMIT_TABLE_BEGIN =
  '<!-- BEGIN GENERATED: rate limits from apps/api/src/registry/route-registry.ts — do not edit by hand -->';
export const RATE_LIMIT_TABLE_END = '<!-- END GENERATED: rate limits -->';

/**
 * #729: the per-route rate-limit table for `docs/security/rate-limits.md`.
 * Generated from the registry so the security doc cannot drift; a test in
 * `test/route-registry.conformance.test.ts` fails CI when it does.
 * Regenerate with `npx tsx tools/insert-rate-limit-table.mts`.
 */
export function renderRateLimitTable(): string {
  const lines = [
    '| Method | Path | Auth | Rate limit | Status |',
    '|---|---|---|---|---|',
  ];
  for (const e of ROUTE_REGISTRY) {
    lines.push(`| ${e.method} | \`${e.path}\` | ${e.auth} | ${e.rateLimit} | ${e.status} |`);
  }
  return lines.join('\n');
}
