# ADM-10 — Admin sign-in end-to-end on the live site

- **Epic / workstream:** Epic 11 (admin & ops) / Admin dashboard
- **Priority:** P0 (launch-blocker — Karan is blocked from every admin surface until this works)
- **Scope:** Infra + backend + frontend verification
- **Bug:** tracked item `goal_9b76d70a3a99` ("Admin sign-in broken on live site")

## User story

As Karan, I open the live site's `/admin/login` on my phone, enter my email, receive the magic-link email, tap it, and land signed in on the admin dashboard — no "Sending..." hang, no missing email.

## Background

Two root causes found 2026-09-25/26:

1. **SWA had no linked backend.** The Static Web App never had the Function App linked as its backend API, so same-origin `/api/*` requests from the live site fell through to the Angular `navigationFallback` — POSTs returned 405, GETs returned `index.html`. The direct Function App URL worked fine; only the live-site path was broken. (Fix: PR #172 — Bicep `linkedBackends` + `/api/*` excluded from `navigationFallback` + regression test.)
2. **Email never sends.** The API's email provider defaults to `'log'`, so magic links are written to server logs and never emailed. Azure Communication Services was chosen for email but never provisioned — no `CommunicationService` resource exists in Bicep.

## Decision (Karan, 2026-09-26)

**Keep Free, use cross-origin API.** Azure's Free SKU rejects SWA `linkedBackends` (PR #172 reverted by #174); Karan will not upgrade to Standard. The Angular app calls the Function App directly at its public URL with CORS + credentials. This also overrides the standing `api.baseUrl: ''` default — Karan approved.

## Scope split

- **Infra (Bicep, IaC only — never manual portal changes):**
  - Provision `Microsoft.Communication/communicationServices` (Free tier) + an email `domains` resource using the Azure-managed domain (no custom-domain verification needed for dev).
  - Wire the connection string into Key Vault; pass `emailProvider: 'acs'` + secret URI to the Function App (dev environment).
  - Keep `'log'` as the safe default when no ACS string is provided (fail closed, never crash on send).
  - **CORS on the Function App:** `allowedOrigins` = live SWA hostname + `http://localhost:4200` (local dev), `supportCredentials: true`. Never `*` with credentials.
- **Backend (`apps/api`):**
  - Verify the `acs` email provider path sends via ACS Email with the magic-link template; non-allowlisted emails still get the identical no-oracle response and no send.
  - **Session cookie for cross-origin:** `SameSite=None; Secure` (Lax won't send cross-site) + `HttpOnly` + `Path=/`; 7-day expiry kept.
  - Contract test: allowlisted request → ACS send invoked (mock the client); non-allowlisted → send never invoked.
- **Frontend (`apps/web`):**
  - Set `api.baseUrl` to the dev Function App URL.
  - All API `HttpClient` calls use `withCredentials: true` so the session cookie flows cross-origin.
  - Verify `/admin/login` transitions Sending → sent state against the live API (no mocks).

## Acceptance criteria

1. `POST https://<function-app>/api/v1/admin/auth/request` (called cross-origin from the live site) with the allowlisted email returns 200 and Karan receives the magic-link email in his inbox.
2. Tapping the link opens `/admin/verify`, establishes the 7-day session cookie (`SameSite=None; Secure; HttpOnly`), and lands on `/admin/leads` signed in.
3. Non-allowlisted email → identical "Check your email" copy, no email sent (no oracle).
4. CORS: the live SWA origin is allowed with credentials; a disallowed origin gets no `Access-Control-Allow-Origin` (test).
5. Bicep is the only infra change path; `deploy-dev` Bicep step green.

## Test plan

- API contract tests for the ACS send / no-oracle paths (mocked ACS client).
- Config regression test: `emailProvider` defaults to `'log'` when ACS is unconfigured.
- **Browser QA (live, after deploy):** Chrome + Safari/WebKit, desktop + 375px — full request → email → verify → dashboard flow with Karan's real inbox; session persists across refresh.

## Dependencies

- `deploy-dev` Bicep step green (ACS + CORS live).
- Karan's inbox access for the live email check (he does this himself).

## Placeholders used

- Azure-managed ACS domain for dev; custom sender domain is a future production task (needs domain + DNS verification).
