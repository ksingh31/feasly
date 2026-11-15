# OWASP ASVS 4.0.3 Level 1 — self-review (#731, BE8-002)

- **Date:** 2026-11-15 · **Scope:** `apps/api` (Azure Functions), `apps/web`
  (SWA), `packages/mcp`, `infra/bicep` as on `main` @ `849ca2fa`.
- **Method:** code review against every L1 requirement, plus the probes in
  [pentest-checklist.md](pentest-checklist.md) (run log 2026-11-15).
- **Result key:** **Pass** · **Fail** (an issue is filed) · **N/A** (the
  feature does not exist, or an identity provider owns it) · **Partial** (the control
  exists but has a gap; an issue is filed).
- **Identity:** Staff and builder sign-in uses **Microsoft Entra External ID**
  (email + password, MFA, lockout, recovery). Consumers and leads hold
  **single-use / expiring magic tokens** only, never a password. So most of V2
  (passwords) is delegated to Entra and marked N/A here.

**No High finding is open.** Open item: F-5. F-3, F-6 and F-7 are fixed (see the bottom of this file).

## V1 Architecture

ASVS 4.0.3 V1 has no L1 requirements. A threat model and PII flow map are
provided anyway: [threat-model.md](threat-model.md).

## V2 Authentication

| ID | Requirement (short) | Result | Evidence |
|---|---|---|---|
| 2.1.1–2.1.12 | Password length, composition, breach check, change, paste, show | N/A | No Feasly-managed passwords. Entra External ID owns passwords. |
| 2.2.1 | Anti-automation on auth | Pass | Entra lockout. Feasly-side: `POST /builder/auth/request` 5/hr per email, Entra callbacks 10/15min per IP, magic-link reissue cooldown ([rate-limits.md](rate-limits.md)) |
| 2.2.2 | Weak authenticators (SMS/email) only as secondary | Pass | Email magic links grant only lead-scoped report access or a builder portal session. Staff admin sign-in is Entra-only. |
| 2.2.3 | Notify on credential/authenticator change | N/A | Owned by Entra |
| 2.3.1 | System-generated initial secrets are random and expire | Pass | Invitations and magic links are random, hashed at rest, and expire (`magic-link.service.ts`, `user-invitation-email`) |
| 2.5.1–2.5.4, 2.5.6 | Credential recovery | N/A | Owned by Entra. Lead magic-link reissue gives the same response whether or not the address exists (`magic-link.route.ts`). |
| 2.7.1 | Out-of-band authenticators not over clear-text SMS/PSTN | Pass | Email over TLS only. No SMS. |
| 2.7.2 | OOB tokens expire (10 min for verification) | Partial | Lead report links last 7 days by design (D-02). These are access tokens, not login OTPs. Accepted: they grant only one lead's own report. |
| 2.7.3 | OOB tokens single-use | Pass | Builder magic links are consumed on verify. Report tokens are long-lived by design (they *are* the report URL), as above. |
| 2.8.1 | Time-based OTP lifetime | N/A | No TOTP in Feasly. Entra owns MFA. |

## V3 Session management

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 3.1.1 | Session token never in URL | Pass | Sessions use the `Authorization: Bearer` header or an httpOnly cookie. Magic tokens in URLs are one-time/lead-scoped credentials, not sessions. |
| 3.2.1 | New token on authentication | Pass | A fresh random session is created on every verify/callback (`admin-auth.service.ts`, `builder-auth.service.ts`) |
| 3.2.2 | ≥ 64 bits entropy | Pass | `randomBytes(32)` session tokens (`builder-auth.service.ts`), SHA-256 hashed at rest (`hashSessionToken`) |
| 3.2.3 | Stored securely in browser | Pass (accepted) | httpOnly + Secure cookie. The SPA also persists the builder session token in localStorage via the NGXS storage plugin, as a Bearer fallback for Safari ITP. Accepted because the CSP blocks third-party script, so XSS is the only way to read it. Mitigated by 5.2.1. |
| 3.3.1 | Logout invalidates the session | Pass | `POST …/auth/logout` revokes the server-side row. A disabled user loses access on the next request (`auth-context.service.ts`). |
| 3.3.2 | Periodic re-authentication | Pass | Admin session TTL 7 days (`ADMIN_SESSION_TTL_SECONDS`). Builder session TTL is in config. |
| 3.4.1 | Cookie `Secure` | Pass | `admin-auth.route.ts`, `builder-auth.route.ts` |
| 3.4.2 | Cookie `HttpOnly` | Pass | Same files |
| 3.4.3 | Cookie `SameSite` | Pass | `SameSite=None` is required for the cross-origin SPA. Cookie-authenticated state-changing requests must carry an allowlisted Origin/Referer (`middleware/csrf.ts`, **F-6** fixed in #794). |
| 3.4.4 | `__Host-` prefix | N/A (accepted) | Cross-origin cookie on the API host. Revisit when the API moves same-origin. |
| 3.4.5 | Cookie path scoped | Pass | `Path=/` on a dedicated API host. No other apps share the origin. |
| 3.7.1 | Re-auth / secondary check before sensitive changes | Pass | Money and user-management actions need specific permissions and are written to the audit log. Admins and builder_admins can't be borrowed via view-as. |

## V4 Access control

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 4.1.1 | Access control enforced server-side | Pass | `enforceRoutePermissions` driven by the registry runs on every adapter. A route missing from the registry gets a 500 ([route-audit.md](route-audit.md)). |
| 4.1.2 | Access-control data can't be changed by users | Pass | Builder id, role, and view-as state are read from the server-side session only |
| 4.1.3 | Least privilege | Pass | Role → permission map (`auth/permissions.ts`). The conformance test checks the role × route matrix. |
| 4.1.5 | Fails securely | Pass | Unknown view-as target → empty permissions. Unknown route → 500. Missing builder context → 403. |
| 4.2.1 | IDOR protection | Pass | `test/tenant-isolation.test.ts` gates every parameterised builder/magic-token route |
| 4.2.2 | Anti-CSRF | Pass | Bearer-header auth (primary in the SPA) is not CSRF-able. Cookie-authenticated non-GET/HEAD/OPTIONS requests from non-allowlisted origins get 403 + a `csrf.denied` audit row (**F-6**, fixed in #794). |
| 4.3.1 | Admin interfaces use MFA | Pass | Entra External ID (staff) with MFA |
| 4.3.2 | Directory browsing / metadata disabled | Pass | Functions host serves no listings. SWA serves only built assets. No `.git` deployed. |

## V5 Validation, sanitization and encoding

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 5.1.1 | HTTP parameter pollution | Pass | zod schemas from `packages/contracts`. Repeated headers take the first value (`cors.ts`, `client-ip.ts`). |
| 5.1.2 | Mass assignment | Pass | zod `strict`/picked DTOs. Stores write only named columns. |
| 5.1.3 | Positive input validation | Pass | zod on every body/query (`packages/contracts`) |
| 5.1.4 | Structured data strongly typed | Pass | Same; UUID regexes on path ids |
| 5.1.5 | Redirects to allowlisted destinations only | Pass | Auth callbacks redirect to config-owned URLs only. No user-supplied `returnTo` is followed off-site. |
| 5.2.1 | Untrusted HTML sanitized | Pass | Angular template binding auto-escapes. No `bypassSecurityTrust*` or `[innerHTML]` in production web code. |
| 5.2.2 | Unstructured data sanitized | Pass | Comment/note bodies are length-limited and rendered as text |
| 5.2.3 | Email injection | Pass | ACS SDK with structured recipients. Templates escape user values (`check-email-copy.mjs`). |
| 5.2.4 | No eval / dynamic code | Partial | No `eval` in app code, but the SWA CSP allows `'unsafe-eval'`. **F-5** |
| 5.2.5 | Template injection | Pass | Email templates are TS functions, not runtime-compiled templates |
| 5.2.6 | SSRF | Pass | Outbound hosts are fixed in config (`SOCRATA_BASE_URL`, ArcGIS). The address is a query value. A URL-shaped address returns 400 (probe P-9). |
| 5.2.7 | SVG scriptable content | N/A | No user-uploaded SVG |
| 5.2.8 | Expression/markdown injection | Pass | LLM narrative is rendered as text. No markdown→HTML rendering of user input. |
| 5.3.1 | Context-aware output encoding | Pass | Angular escaping. JSON APIs. CSV export neutralizes formulas. |
| 5.3.2 | Unicode-safe encoding | Pass | UTF-8 JSON throughout |
| 5.3.3 | XSS-safe escaping | Pass | As 5.2.1 |
| 5.3.4 | Parameterized SQL | Pass | Drizzle query builder / tagged `sql` with bound params |
| 5.3.5 | No string-concatenated queries | Pass | Same. The Socrata `$where` is built from escaped literals in `property.service.ts`. |
| 5.3.6 | JSON injection | Pass | `JSON.stringify` only |
| 5.3.7 | LDAP injection | N/A | No LDAP |
| 5.3.8 | OS command injection | N/A | No shell-outs at runtime |
| 5.3.9 | LFI/RFI | N/A | No user-chosen file paths |
| 5.3.10 | XPath/XML injection | N/A | No XML parsing of user input |
| 5.5.1 | Serialized objects integrity | N/A | No native deserialization |
| 5.5.2 | XXE | N/A | No XML |
| 5.5.3 | Untrusted deserialization | Pass | `JSON.parse` + zod only |
| 5.5.4 | JSON.parse safe in JS | Pass | No `eval`-based parsing |

## V6 Cryptography

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 6.2.1 | Crypto modules fail securely | Pass | Node `crypto` (randomBytes, SHA-256, HMAC with `timingSafeEqual` for signed unsubscribe tokens). Stripe SDK `constructEvent` for webhooks. |

## V7 Error handling and logging

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 7.1.1 | No credentials/session tokens in logs | Pass | Tokens are hashed before storage. `sanitize-error.ts`. Lead bodies are never logged. |
| 7.1.2 | No other sensitive data in logs | Pass | PII is excluded from telemetry (`sanitize-error.test.ts`, lead route) |
| 7.4.1 | Generic error with a correlation id | Pass | RFC 7807 ProblemDetails with `correlationId`. Stack traces are never returned (`middleware-errors.test.ts`). |

## V8 Data protection

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 8.2.1 | Anti-caching headers on sensitive responses | Pass | API responses send `Cache-Control: no-store` by default (**F-7**, fixed in #795). |
| 8.2.2 | No sensitive data in browser storage | Pass (accepted) | `apps/web/src/app/app.config.ts` `beforeSerialize` strips the report token, relay code, and the builder lead list (homeowner PII). `LeadState` keeps the homeowner's *own* gate details on their own device so the report survives a reload. Accepted. |
| 8.2.3 | Client data cleared after session end | Pass | Logout clears the stored Bearer and state |
| 8.3.1 | Sensitive data in body/headers, not query string | Partial | Magic tokens ride in URL paths by design (email links). Accepted: each is scoped to one lead's own data, and links are `Referrer-Policy: strict-origin-when-cross-origin`. |
| 8.3.2 | User can export/delete their data | Pass | `GET /privacy/export`, erase-request + confirm (PIPEDA) |
| 8.3.3 | Clear privacy language | Pass | `/privacy` (CASL/PIPEDA copy checks in CI) |
| 8.3.4 | Sensitive data inventoried | Pass | [threat-model.md](threat-model.md) PII flow map |

## V9 Communications

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 9.1.1 | TLS for all client connectivity | Pass | SWA + Function App HTTPS-only. HSTS `max-age=31536000; includeSubDomains; preload`. |
| 9.1.2 | Strong cipher suites only | Pass | Azure-managed TLS. The platform default minimum is TLS 1.2. `httpsOnly: true` in `infra/bicep/modules/function-app.bicep`. |
| 9.1.3 | Old TLS disabled | Pass | Same (platform default minimum TLS 1.2) |

## V10 Malicious code

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 10.3.1 | Auto-update integrity | N/A | No in-app auto-update |
| 10.3.2 | Integrity of third-party assets | Pass | No third-party scripts. Fonts only (CSP `font-src`/`style-src` Google Fonts). |
| 10.3.3 | Subdomain takeover | Pass | No dangling CNAMEs found. Reserved placeholder origins such as `demo.example.com` are no longer emitted in `frame-ancestors` (**F-3**, fixed in #796). |

## V11 Business logic

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 11.1.1 | Sequential step order enforced | Pass | Lead gate before full report. Contract recorded before commission invoice. Invoice states are enforced server-side. |
| 11.1.2 | Realistic human timing | Pass | Rate limits per IP/email/tenant/key ([rate-limits.md](rate-limits.md)) |
| 11.1.3 | Business limits per user | Pass | Narrative 5/day per estimate. Magic-link sends per email. |
| 11.1.4 | Anti-automation on money/mail flows | Pass | Postgres-shared limits on money/mail endpoints (#729) |
| 11.1.5 | Business-logic limits documented/enforced | Pass | [rate-limits.md](rate-limits.md) is generated from the registry. Dollar figures come only from the cost engine. |

## V12 Files and resources

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 12.1.1 | Upload size limits | N/A | No user file uploads |
| 12.3.1–12.3.5 | Path traversal / LFI / command via filenames | N/A | No user-chosen file names or paths. Invoice PDFs are generated in memory. |
| 12.4.1 | Untrusted files stored outside webroot | N/A | No uploads |
| 12.4.2 | Uploaded files AV-scanned | N/A | No uploads |
| 12.5.1 | Only intended file types served | Pass | SWA serves the build output only. `/assets/*` is never rewritten. |
| 12.5.2 | Uploaded files never executed | N/A | No uploads |
| 12.6.1 | SSRF allowlist for server-side fetches | Pass | As 5.2.6 |

## V13 API and web services

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 13.1.1 | Same encoding/parsers across components | Pass | JSON + zod contracts shared by web, API, MCP |
| 13.1.3 | No secrets/API keys in URLs | Pass | API keys use the `Authorization` header only (`api-key-auth.test.ts`) |
| 13.2.1 | Only intended HTTP methods enabled | Pass | Methods are bound per `function.json` and checked against the registry (`http-route-bindings.test.ts`) |
| 13.2.2 | JSON schema validation | Pass | zod on every body |
| 13.2.3 | CSRF protection on cookie-based REST | Pass | As 4.2.2 (**F-6** fixed in #794). |
| 13.3.1 | XSD validation | N/A | No SOAP/XML |

## V14 Configuration

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 14.2.1 | Components up to date | Pass | Dependabot. `dependency-audit` required check (`npm audit --audit-level=high`). |
| 14.2.2 | Unneeded features removed | Pass | Planned routes have no bindings. Only registry routes are bundled (`check-function-bundle.mjs`). |
| 14.2.3 | Third-party assets with SRI | N/A | No third-party scripts |
| 14.3.2 | Debug modes off in prod | Pass | Production Angular build. `NODE_ENV` gates dev-only CORS origins. |
| 14.3.3 | No version-revealing headers | Pass | No `X-Powered-By`. `Server: Kestrel` without a version (probe 2026-11-15). Health returns the app version only. |
| 14.4.1 | Content-Type with charset on responses | Pass | `application/json; charset=utf-8` and `application/problem+json; charset=utf-8` (probe 2026-11-15) |
| 14.4.2 | Attachments use Content-Disposition | Pass | CSV export and invoice PDF set `Content-Disposition: attachment` |
| 14.4.3 | CSP present | Partial | CSP is present and strict except `'unsafe-eval'` in `script-src`. **F-5** |
| 14.4.4 | `X-Content-Type-Options: nosniff` | Pass | SWA global headers + API middleware |
| 14.4.5 | HSTS | Pass | SWA global headers |
| 14.4.6 | Referrer-Policy | Pass | `strict-origin-when-cross-origin` |
| 14.4.7 | Framing protection | Pass | `frame-ancestors 'none'` globally. `/embed` allows only tenant origins (**F-3**). |
| 14.5.1 | Only allowed HTTP methods | Pass | As 13.2.1 |
| 14.5.2 | Origin header not used for authn/authz | Pass | Origin only drives the CORS allowlist |
| 14.5.3 | CORS allowlist strict | Pass | Exact-match allowlist, no wildcard, no `null`. `test/middleware-cors.test.ts`. Probe P-11 (evil origin → no ACAO). |

## Open findings

| # | Severity | Finding | Issue |
|---|---|---|---|
| F-5 | Low | SWA CSP `script-src 'unsafe-eval'` | #797 |

F-1 (view-as audit gap on `permissionsAnyOf` routes) was **fixed in #731**. F-3 (#796, PR #809),
F-6 (#794, PR #813) and F-7 (#795, PR #810) were fixed on main before go-live.
