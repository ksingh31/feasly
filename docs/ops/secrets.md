# Secret inventory & rotation runbook (HRD-07)

> **Rule:** no secret value ever lives in the repo, the client bundle, or CI
> logs. This page lists *where each secret lives* (never the value) and how
> to rotate it. CI enforces this with `tools/check-secrets.mjs` (diff scan +
> web-bundle scan, `secrets-scan` job in `.github/workflows/ci.yml`).

## Where secrets live

| Secret | Used by | Lives in | Notes |
|---|---|---|---|
| `DATABASE_URL` / `POSTGRES_PASSWORD` | `apps/api` (Drizzle) | Function App app settings (prefer Key Vault references) | Azure Database for PostgreSQL — Flexible Server, free tier |
| `STRIPE_SECRET_KEY` | `apps/api` billing service | Function App app settings | `sk_test_…` outside prod, `sk_live_…` in prod — enforced at startup (`config.ts`) |
| `STRIPE_WEBHOOK_SECRET` | `apps/api` Stripe webhook route | Function App app settings | `whsec_…`; signature verified on the raw body before parsing |
| `EMAIL_ACS_CONNECTION_STRING` | `apps/api` email service | Function App app settings | Azure Communication Services (chosen 2026-09-25); sender domain still pending Karan |
| `EMAIL_POSTMARK_SERVER_TOKEN` | `apps/api` email service (dormant) | Function App app settings, if ever used | Postmark path kept dormant; `EMAIL_PROVIDER=acs` |
| `UNSUBSCRIBE_TOKEN_SECRET` | `apps/api` unsubscribe HMAC tokens | Function App app settings | Rotating invalidates outstanding unsubscribe links (30-day TTL) |
| `ADMIN_API_KEY` | legacy admin auth | Function App app settings | Being replaced by `admin/01` session auth; remove once sessions ship |
| `FEASLY_SWA_DEPLOY_TOKEN` | CD workflow (SWA deploy) | GitHub Actions **secret** | Never in code; referenced as `${{ secrets.FEASLY_SWA_DEPLOY_TOKEN }}` |
| Magic-link tokens, API keys | `apps/api` | Postgres, **hash-only** | Raw values are shown once at issuance and never stored |

### Not secrets (safe in the repo / CI)

- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` — GitHub
  **variables** (not secrets). Azure auth is OIDC-federated; there is no
  `AZURE_CLIENT_SECRET` anywhere.
- `STRIPE_FLAT_PRICE_ID`, Socrata dataset IDs, queue names, rate-limit
  tunables — identifiers and configuration, not credentials.
- Stripe *publishable* keys (`pk_…`) — safe for the client by design; none
  are currently used.

## Rotation procedures

Who: Karan (or whoever holds the Azure / Stripe / GitHub admin role).
Each rotation: update the setting → restart the Function App (or re-run the
workflow) → verify health → delete the old credential at the provider.

1. **Postgres password** — Azure portal → the flexible server → reset
   administrator password → update `DATABASE_URL` / `POSTGRES_PASSWORD` app
   settings → restart Function App → CI `backup-config` job stays green.
2. **Stripe secret key** — Stripe Dashboard → Developers → API keys → roll
   key → update `STRIPE_SECRET_KEY` → restart → send a test webhook.
3. **Stripe webhook secret** — Dashboard → Webhooks → select endpoint →
   reveal/roll signing secret → update `STRIPE_WEBHOOK_SECRET` → restart →
   confirm `stripe-signature` verification passes on the next event.
4. **ACS connection string** — Azure portal → the Communication Services
   resource → Keys → regenerate → update `EMAIL_ACS_CONNECTION_STRING` →
   restart → send a test email to `karanbirsingh667@gmail.com` (standing
   test address; no other recipient without Karan's explicit request).
5. **Unsubscribe token secret** — generate 32+ random bytes →
   update `UNSUBSCRIBE_TOKEN_SECRET` → restart. Outstanding unsubscribe
   links break (acceptable: 30-day TTL, users can re-request).
6. **SWA deploy token** — Azure portal → the Static Web App →
   reset deployment token → update the `FEASLY_SWA_DEPLOY_TOKEN` GitHub
   secret → re-run CD.

## If a secret leaks

1. **Rotate it first** (table above) — assume it is compromised.
2. Remove it from git history only if the push was recent and un-pulled;
   otherwise rotate-and-move-on (history rewrites on a shared main are
   worse than the leak once rotated).
3. Check GitHub secret-scanning alerts on the repo for the incident record.
4. Add a regression fixture to `tools/check-secrets.test.mjs` if the
   scanner missed the shape.

## Platform guardrails (verified)

- GitHub **secret scanning**: enabled on `ksingh31/feasly` (verified
  2026-09-25 via API).
- GitHub **push protection**: enabled — pushes containing a known secret
  pattern are blocked before they land.
- CI `secrets-scan` job: fails the PR on secret-shaped additions to the
  diff (allowlisted test fixtures only, each with a documented reason in
  `tools/.secrets-allowlist`).
- CI bundle scan: fails the build if any secret pattern appears in the
  production web bundle.
- `apps/api` lint tripwire (`tools/check-email-secrets.mjs`, from email/01):
  fails on committed secret-looking literals inside the email module and
  `config.ts` — a narrower, module-level complement to the repo-wide gate.
