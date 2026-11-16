# Threat model (lite) + PII flow map — HRD-001 (#731, 2026-11-15)

Scope: the Feasly system as it stands on `main` @ `849ca2fa`. Method: STRIDE-lite per
trust boundary. Controls reference code and tests, so they can be re-checked.

## Actors and trust boundaries

| Actor | Credential | Reaches |
|---|---|---|
| Anonymous visitor / homeowner | none (IP rate limits) | Public estimate, property lookup, lead gate, events, waitlist, OpenAPI |
| Lead (gated homeowner) | Magic token (report token, email link, signed unsubscribe token) | Their own report, revisions, privacy export/erase, narrative, unsubscribe |
| Builder user (`builder_admin`, `builder_member`) | Builder session (Entra / magic link) | Their own tenant's leads, comments, users, invoices |
| Staff (`super_admin`, `admin`, `viewer`) | Admin session (Entra External ID) | Admin console, billing actions, users, calibration |
| Agent / partner | API key (`feasly_live_…`, scoped) | MCP endpoint (same engine) |
| Stripe | `Stripe-Signature` HMAC | Webhook |
| Builder site | Tenant key + `frame-ancestors` allowlist | `/embed` iframe, embed config |

Boundaries: browser ↔ SWA, browser ↔ Function App (CORS allowlist), Function App ↔
Postgres (private, Key Vault-held credentials), Function App ↔ third parties (below).

## PII flow map

| Data | Collected at | Stored | Sent to | Retention / deletion |
|---|---|---|---|---|
| Name, email, phone, address (lead gate) | `POST /api/v1/leads` | Postgres `leads` (erasure requests keep only an email hash) | Azure Communication Services (email to the lead). Google Sheets sync (builder's sheet, values written `RAW`). Assigned builder's portal. | Erase request + confirm deletes leads (`privacy.service.ts`). Export via `/privacy/export`. |
| Property address / assessed value | Property lookup | Estimate rows (address key) | City of Calgary open data (Socrata / ArcGIS). The address is sent as a query. | Public City data, not personal on its own |
| Estimate inputs + engine output | Estimate | Postgres `estimates` (immutable) | **LLM provider (Gemini, OpenAI-compatible endpoint, `NARRATIVE_ENDPOINT`)**: the prompt carries **engine output + city/community aggregates only**. `buildNarrativePrompt` (cost-engine) accepts no lead fields, and passing `CostData` is a compile error. No name, email, phone or street address goes to the LLM. | Narratives persist with the estimate |
| Builder user email/name | Entra sign-in / invite | Postgres `users`, memberships, sessions (token hashes) | Entra External ID, ACS (invitations) | Disable/remove user revokes sessions immediately |
| Payment data | Stripe Checkout / SetupIntent | **Not stored by Feasly.** Only Stripe ids and invoice metadata. | Stripe | Stripe retention |
| Analytics events | `POST /api/v1/events` | Postgres funnel tables | none | Schema has no free-text PII fields |
| Telemetry | All | App Insights / Log Analytics | Azure Monitor | Error sanitizer strips PII. Lead bodies are never logged. |
| Audit log | Admin/builder actions | `admin_audit_log` | none | Actor email + ids only. Never request bodies. |

Third parties: Microsoft (Azure, Entra, ACS, Monitor), Stripe, Google (Sheets API,
Gemini), City of Calgary open data. Fonts are loaded from Google Fonts. There are no
third-party scripts.

## STRIDE-lite by boundary

| Threat | Where | Control | Evidence |
|---|---|---|---|
| **S**poofing a builder/staff session | All protected routes | Hashed random session tokens. Entra sign-in. Disabled user → null context. | `auth-context.service.test.ts` |
| Spoofing client IP to dodge limits | Rate limiter | Client IP from the platform header only, never `X-Forwarded-For` | `estimate.spoofed-xff.test.ts`, `client-ip.test.ts` (#729) |
| Spoofing Stripe | Webhook | `constructEvent` HMAC + timestamp tolerance. Processed event ids recorded, so a replay is a no-op. | `billing-webhook.service.test.ts` |
| **T**ampering with tenant id | Builder routes | Builder id comes only from the session. Cross-tenant → 404/403. | `tenant-isolation.test.ts` |
| Tampering with dollar figures | Narrative / LLM | Cost engine is the only figure source. `validateNarrative` rejects non-engine $ figures. | `narrative.service.test.ts` |
| CSV / formula injection | Leads export, Sheets sync | Export cells starting with `= + - @` (or tab/CR) are quote-prefixed. Sheets writes `RAW`. | `admin-leads-export.adapter.test.ts` |
| **R**epudiation under impersonation | View-as | Activation, exit, every protected action, and denials are logged under the real actor | `view-as-audit-attribution.test.ts`, `view-as.service.test.ts` |
| **I**nformation disclosure via IDOR | Parameterised routes | Isolation suite + coverage gate | `tenant-isolation.test.ts` |
| Token oracle | Magic-token routes | Unknown and expired tokens return the same response | `phase2-report.test.ts`, `unsubscribe.service.test.ts` |
| Rates/margins leak | Public serializers, OpenAPI | Secret-leak tests. OpenAPI carries no parameters. | `embed-config.route.test.ts`, `openapi.drift.test.ts` |
| Pre-gate figures in DOM | Report | **Accepted** (owner decision 2026-11-13). The blur is a nudge, not a boundary. | CLAUDE.md |
| **D**enial of service / cost | Estimate, narrative, mail, LLM | Per-IP/email/tenant/key limits shared in Postgres for money/mail endpoints. Narrative 5/day per estimate. Budget cap CA$10/mo. | [rate-limits.md](rate-limits.md) |
| Prompt injection | Narrative (live), chat (planned) | Narrative prompt contains no user free text. Output is validated. Chat is **not live**: it needs input isolation, an output filter, and a global budget before go-live. | route-audit F-2 |
| **E**levation via view-as | Admin/builder view-as | Admin targets rejected. The borrowed view never includes `view_as`. An unknown target fails closed. | `view-as.service.test.ts`, `builder-view-as.service.test.ts` |
| CSRF on cookie sessions | Cookie-authenticated POSTs | **Open, F-6 (Medium).** Bearer is primary. The cookie path lacks an Origin check. | asvs-l1.md |
| SSRF | Property lookup | Fixed outbound hosts from config. The address is a query value. | Probe P-9 |
| Clickjacking | SWA | `frame-ancestors 'none'` globally. `/embed` allows only tenant origins. | `check-security-headers.mjs` |

## Residual risks accepted for launch

1. Long-lived lead report tokens in URLs (they are the report link). Mitigations: one lead's
   own data only, Referrer-Policy, reissue flow.
2. The builder session token persists in localStorage (Safari ITP fallback).
3. Public repo exposes resource names (owner decision 2026-11-15). Personal-detail scrub is #758.
