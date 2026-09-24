# BE-4 — Auth & authorization

### BE4-001 — Magic-link issuance & JWT session
**Size:** M
**Description:** `AuthService` (`interface IAuthService`): issues single-use
tokens (crypto-random, hashed at rest, TTL from config), verifies them, and on
success mints a short-lived JWT (httpOnly, Secure, SameSite=Lax cookie) with
claims `{ sub: leadId|userId, role, tenantId? }`. Rotation on every verify;
revocation list for logout. No passwords anywhere in V1.
**Acceptance criteria:**
- Token entropy ≥ 128 bits; timing-safe compare on verify.
- Cookie flags correct in production (Secure) and workable locally.
**Tests:** full issue→verify→refresh→revoke cycle; tampered JWT rejected.

### BE4-002 — Authorization middleware: dashboard lockdown
**Size:** M
**Description:** `requireAuth` (valid JWT → attaches principal) and
`requireRole('builder' | 'admin')`. **Every dashboard/admin route (BE-6) uses
both; public routes (BE-3) use neither** — enforced by a route-registry test
that fails the PR if a `/dashboard/*` or `/admin/*` route lacks the middleware.
Cross-tenant isolation: builders only see their own tenant's leads
(`tenantId` claim enforced in the service layer, not just the route).
**Acceptance criteria:**
- No cookie → 401 `UNAUTHENTICATED`; wrong role → 403 `FORBIDDEN`.
- Builder A cannot read builder B's leads (test with two tenants).
**Tests:** middleware unit tests; registry test; tenant-isolation test.

### BE4-003 — Rate limiting, idempotency, audit
**Size:** M — Per-route rate limits from config (stricter on magic-link +
lead submit). Idempotency-Key header on POSTs: same key → same response, no
double side effects. Append-only audit log (who did what, when) for
auth-sensitive actions. **Tests:** idempotent double-POST creates one lead.
**Dependencies:** BE-0.
