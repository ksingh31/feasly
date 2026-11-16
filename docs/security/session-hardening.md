# Admin and builder session hardening (#730)

Owner decision (2026-11-15, delegated): MFA for **admins only**, through Entra
free features (no SMS, no paid tier). Builders stay on magic link. Admin
sessions: 12 h absolute / 1 h idle. Builder sessions: 7 days absolute / 24 h
idle. Keep the token in memory with a short TTL plus silent refresh, not
`localStorage`. If same-site cookies need paid infrastructure, skip them for
launch.

## Server-side session limits (implemented)

| Limit | Admin | Builder | Config (`apps/api/src/config.ts`) |
|---|---|---|---|
| Absolute lifetime | 12 h | 7 days | `ADMIN_SESSION_TTL_SECONDS`, `BUILDER_SESSION_TTL_SECONDS` |
| Idle timeout | 1 h | 24 h | `ADMIN_SESSION_IDLE_TIMEOUT_SECONDS`, `BUILDER_SESSION_IDLE_TIMEOUT_SECONDS` |
| Activity write interval | 60 s | 60 s | `SESSION_ACTIVITY_TOUCH_INTERVAL_SECONDS` |
| Re-auth window for dangerous actions | 30 min | 30 min | `SESSION_REAUTH_WINDOW_SECONDS` |

- `services/session-policy.ts` wraps both session stores in `composition.ts`,
  so every reader (guards, `AuthContextService`, view-as, logout) sees the same
  answer. The effective deadline is the earliest of `expires_at`,
  `created_at + absolute TTL` and `last_seen_at (or created_at) + idle timeout`.
  Lowering a TTL in config also caps sessions that already exist.
- `last_seen_at` (migration `0053`) is written at most once per touch interval.
  A failed write never fails the request; it can only make the idle timeout
  fire earlier.
- A timed-out session answers `401 SESSION_EXPIRED` on `/auth/me`, so the
  sign-in page shows the expiry copy.

### Re-auth for dangerous actions

Registry entries flagged `recentAuth: true` need a sign-in (the session's
`created_at`) no older than `SESSION_REAUTH_WINDOW_SECONDS`. If the sign-in is
older, `enforceRoutePermissions` returns `401 REAUTH_REQUIRED` before the route
runs, and an `authz.denied … permission=recent-auth` audit row is written.
Flagged routes:

- `POST /api/v1/admin/view-as`, `POST /api/v1/builder/view-as`
- `POST /api/v1/admin/billing/invoices/{id}/mark-paid`
- `PATCH|DELETE /api/v1/admin/users/{id}`, `PATCH|DELETE /api/v1/builder/users/{id}` (deactivation / removal)
- `POST /api/v1/admin/api-keys`, `POST /api/v1/admin/api-keys/{id}/rotate`

The 30-minute default is an engineering choice: short enough that a stolen,
long-lived session can't be used for these actions, and long enough that an
admin working through a batch (for example several mark-paid calls) doesn't
have to sign in again partway through. Change it in config if needed.

## CSRF (already in place)

Cookie-authenticated state changes must carry an allowlisted `Origin` or
`Referer` (`middleware/csrf.ts`, #794). Bearer-authenticated requests can't be
forged by a cross-site form.

## CSP `unsafe-eval` (AC5)

Removed from the SWA CSP `script-src` in #819. Nothing to sign off.

## Still open (tracked separately)

- Web: keep the session token in memory with silent refresh instead of the
  NGXS storage plugin, and send the user to sign in again on
  `401 REAUTH_REQUIRED` (AC1, AC4 client side).
- Entra: require MFA (email OTP) for admin accounts in the External ID tenant,
  record the manual test, and bring the tenant runbook into `docs/auth/` (AC3).
  This needs owner access.
- Single CORS enforcement point through Bicep (AC6), and Dependabot security
  updates plus the patch SLA (scope item 6).
