# Epic 00 — Foundation

## Goal
Stand up everything M1–M6 build on: a private monorepo with branch protection,
GitHub Actions CI/CD (PR previews, staging auto-deploy, gated prod), Azure
infrastructure as Bicep (Static Web App, Functions consumption plan, Postgres
Flexible Server, Key Vault, App Insights, DNS), a migration framework with the
SCHEMA.md core tables in place, local dev parity, and the external accounts
(Postmark, Stripe, domain) staged so later epics can send mail, take payment
scaffolding, and run behind a real domain. Exit: a developer (Muse or Karan)
can clone, run `docker compose up`, seed Calgary, run the full CI suite
locally, open a PR and get a preview environment, and deploy infra changes
via `what-if` + CI — with zero long-lived secrets anywhere.

## Non-goals
- Any production deployment (needs Karan's explicit go-ahead per deploy).
- Angular app code, cost-engine code, or API endpoints (later epics).
- Provisioning real Azure resources (Muse never provisions; Bicep is authored
  and validated via `what-if` only until Karan approves apply).
- Creating GitHub repos/orgs, Azure subscriptions, Postmark/Stripe accounts,
  or buying domains — all NEEDS-KARAN manual steps.

## Key decisions
- Monorepo layout (per BUILD_PLAN.md M0):
  `apps/web`, `apps/api`, `packages/cost-engine`, `packages/contracts`,
  `packages/embed-loader`, `packages/mcp`, `infra/bicep`, `.github/workflows`.
- Actions → Azure auth via OIDC federation; no long-lived service-principal
  secrets, ever.
- Postgres: **Burstable B1ms** (1 vCPU, 2 GiB RAM, 32 GB storage) for
  dev/staging; **B2s at public launch** (parameter change, not a migration).
  Rationale: cheapest Flexible Server SKU, ample for MVP traffic, burstable
  CPU absorbs CI/CD and seed spikes. Backups: 7-day PITR dev/staging,
  30-day PITR in prod, geo-redundant backup off in dev/staging to save cost.
- Function App on **Flex Consumption (FC1)** plan (decided 2026-09-23;
  replaces older Y1 wording). Cold starts of 1–3 s are acceptable at MVP
  scale (the M1 "Analyzing" screen is async by design); revisit Premium EP1
  only if p95 API latency becomes user-visible.
- SWA free tier (per ADR); DNS + managed TLS via Azure DNS zone + SWA custom
  domain verification once Karan approves the domain.

---

## Stories (dependency order)

### FND-001 — NEEDS-KARAN — Create GitHub org/repo and grant access
**Description:** Karan creates (or designates) the GitHub home for Feasly: a
private repository `feasly` (org repo preferred for future team access; his
call), grants Muse/the build agent collaborator access, and confirms the
default branch is `main`. This is the hard dependency for every other story in
this epic — no repo, no CI, no code.

**Acceptance criteria:**
- Private repo `feasly` exists under an org or his account; URL recorded in
  `infra/bicep/parameters/` README or repo root `REPO.md`.
- Build agent has write access; Karan is an owner/admin.
- Decision recorded: org vs personal account (default recommendation: new org
  `feasly` or his existing org if he has one — personal account acceptable for
  M0, migrate later).

**Dependencies:** none (external)
**Size:** S
**Tags:** NEEDS-KARAN

---

### FND-002 — Monorepo scaffold + branch protection
**Description:** Scaffold the full monorepo layout from BUILD_PLAN.md with
workspace tooling (**npm workspaces** — Karan's requested pattern; single
`tsconfig.base.json`; ESLint + Prettier shared config), a root README with
architecture pointer to ADR-001, and per-package `package.json` stubs. Then
apply branch protection on `main`: require PR, require CI green, no direct
pushes, CODEOWNERS assigning Karan.

**Acceptance criteria:**
- Directories exist: `apps/web`, `apps/api`, `packages/cost-engine`,
  `packages/contracts`, `packages/embed-loader`, `packages/mcp`,
  `infra/bicep`, `.github/workflows`; `npm install` succeeds at root.
- `main` branch protection: PR required (min 1 review), required status
  checks = CI workflow jobs, "do not allow bypassing the above settings",
  direct pushes blocked; `.github/CODEOWNERS` lists Karan for all paths.
- Protection config documented in `docs/branch-protection.md` (API commands
  used, since it must be re-applied if the repo is ever recreated).

**Dependencies:** FND-001
**Size:** M

---

### FND-003 — NEEDS-KARAN — Azure subscription access decision
**Description:** Karan decides and provisions access: use an existing Azure
subscription (and if so, which one + who is Owner) or create a fresh
subscription for Feasly (recommended: fresh subscription = clean cost
tracking, no blast radius into other workloads). Muse then records
subscription ID and tenant ID in the Bicep parameter files and Key Vault
naming conventions. No resources are created at this stage.

**Acceptance criteria:**
- Decision recorded in `infra/bicep/README.md`: subscription ID, tenant ID,
  billing scope (new vs existing + rationale).
- Azure CLI `az account show` works for the build agent against that
  subscription (read-only verification only — no resource creation).
- Cost alert: budget of CA$100/mo with email alert to Karan configured on the
  subscription (spending guardrail, read-only-safe setup documented).

**Dependencies:** FND-001
**Size:** S
**Tags:** NEEDS-KARAN

---

### FND-004 — Bicep modules for all Azure resources + per-environment parameters
**Description:** Author (not apply) the complete Bicep for every ADR resource:
resource group, Static Web App, Function App + Flex Consumption plan, Postgres
Flexible Server, Key Vault, Application Insights, DNS zone, **Blob Storage
account** (tenant logos + dispute evidence + generated report assets — added
2026-09-23 per USER_VALIDATION.md P1-12). Provide `dev`/`staging`/`prod`
`.bicepparam` files with environment-appropriate SKUs and settings, and
validate everything with `az deployment group what-if` against each
environment. All secrets are Key Vault references; Managed Identity is the
only auth path between services.

**Acceptance criteria:**
- Files: `infra/bicep/main.bicep`;
  `infra/bicep/modules/resource-group.bicep` (or inline),
  `infra/bicep/modules/static-web-app.bicep`,
  `infra/bicep/modules/function-app.bicep` (Flex Consumption FC1),
  `infra/bicep/modules/postgres.bicep` (B1ms dev/staging; pg 16;
  private-access default with firewall rules parameterized),
  `infra/bicep/modules/key-vault.bicep`,
  `infra/bicep/modules/app-insights.bicep`,
  `infra/bicep/modules/storage.bicep` (private container, SAS-free access via
  Managed Identity; lifecycle rule: dispute evidence ≥7 yr, logos keep-latest),
  `infra/bicep/modules/dns.bicep` (zone + SWA custom-domain verification
  records, domain name parameterized, empty default until FND-014 resolves).
- `infra/bicep/parameters/dev.bicepparam`, `staging.bicepparam`,
  `prod.bicepparam`:
  - dev: Postgres B1ms, 7-day PITR, no geo-backup;
  - staging: Postgres B1ms, 7-day PITR;
  - prod: Postgres **B2s**, 30-day PITR retention, zone-redundant off by
    default (conscious later decision — logged assumption). B1ms → B2s at
    public launch is a parameter change, not a migration.
  - all envs: Function App **Flex Consumption FC1** (decided 2026-09-23;
    replaces the older Y1 Consumption wording — better scale behavior for the
    invoice-reviewer/permit timers).
- `az deployment group what-if` passes clean for all three parameter files
  (no errors; output captured in PR).
- No secret values in Bicep or params — only `@secure()` placeholders and
  Key Vault references; `bicep build` lints clean.
- README in `infra/bicep/` documents the manual `what-if` command and the
  future `az deployment group create` command (marked DO-NOT-RUN without
  Karan approval).

**Dependencies:** FND-002, FND-003
**Size:** M

---

### FND-005 — GitHub Actions OIDC federation to Azure
**Description:** Set up OIDC trust between the repo and Azure (user-assigned
managed identity + federated credentials for `main`, `staging`, and PR
branches) so workflows deploy without any stored client secrets. Document the
exact `az ad app federated-credential create` commands in a runbook so the
setup is reproducible. The federated credential creation itself touches
Azure AD and is done by Karan (or by Muse with Karan watching) — flagged
accordingly.

**Acceptance criteria:**
- `infra/bicep/` (or `docs/oidc-setup.md`) contains the runbook with exact
  commands: managed identity creation, role assignments (least privilege:
  Contributor scoped to the Feasly resource group for CD, Key Vault Secrets
  Officer for the migration job only), federated credential subjects for
  `repo:<org>/feasly:ref:refs/heads/main`, `:environment:staging`,
  `:pull_request`.
- Workflow snippet uses `azure/login@v2` with `client-id`, `tenant-id`,
  `subscription-id` from GitHub variables (not secrets).
- Verification: a dry-run workflow step runs `az account show` successfully
  from Actions on a test branch (no deployment performed).

**Dependencies:** FND-003, FND-004
**Size:** S
**Tags:** NEEDS-KARAN (federated credential creation in his tenant)

---

### FND-006 — Migration framework evaluation spike (recommend one)
**Description:** Evaluate `node-pg-migrate` vs `dbmate` vs `Prisma Migrate`
against Feasly's needs (raw-SQL SCHEMA.md as source of truth, TS monorepo,
CI-run migrations, rollback story, zero ORM lock-in) and recommend one with
written reasoning. Assumption: we stay ORM-free in the API (light query layer
over `pg`), so the winner must work with plain SQL migrations.

**Acceptance criteria:**
- `docs/migration-framework-decision.md` with a comparison table
  (language, SQL-first?, rollback support, CI ergonomics, lock/transaction
  behavior, community health) and a recommendation.
- **Reconciled decision (coordinator, 2026-09-23): dbmate.** TECH_PLAN §10
  carries the full comparison table and CODING_PATTERNS §11 defaults to
  dbmate; the spike's job is to validate (not relitigate) this choice in CI:
  confirm the dbmate binary runs in GitHub Actions + the Functions/CD
  pipeline, forward-only SQL migrations apply cleanly, and `dbmate dump`
  reproduces SCHEMA.md. If the spike finds a blocker, it may reopen the
  decision with evidence; otherwise dbmate stands and FND-007 proceeds.
  (node-pg-migrate: fine tool, but adds an npm-runner dependency for what is
  fundamentally plain-SQL versioning; Prisma Migrate rejected — forces the
  Prisma schema as source of truth, conflicting with SCHEMA.md-as-SQL.)
- Decision is reversible: noted that switching later costs one squashed
  baseline migration.

**Dependencies:** FND-002
**Size:** S

---

### FND-007 — First migration: SCHEMA.md core tables + migration process doc
**Description:** Using the framework chosen in FND-006, write the baseline
migration creating all ten SCHEMA.md tables (`cities`, `tenants`,
`cost_data_versions`, `properties`, `users`, `magic_links`, `estimates`,
`leads`, `api_keys`, `api_usage`) with indexes, plus a `MIGRATION_PROCESS.md`
runbook: how to author/apply/revert migrations locally and in CI, the
"never edit a shipped migration" rule, and the CD ordering (migrate before
deploy, expand-before-contract for breaking changes).

**Acceptance criteria:**
- `infra/db/migrations/001-core-schema.sql` (or `.ts` per framework) creates
  all 10 tables + the two `leads` indexes + `api_usage` index, matching
  SCHEMA.md column-for-column (citext extension enabled for `users.email`,
  `leads.email`).
- `CREATE EXTENSION IF NOT EXISTS "pgcrypto"` included for `gen_random_uuid()`.
- `infra/db/MIGRATION_PROCESS.md` documents: new-migration naming, local
  `up`/`down` commands, CI invocation, the immutability rule, and the
  expand/migrate/contract pattern for breaking changes.
- Migration applies cleanly to a fresh local Postgres and rolls back cleanly
  (`down` verified in CI as part of FND-008).

**Dependencies:** FND-006, FND-011 (needs local Postgres to verify)
**Size:** M

---

### FND-008 — CI pipeline: lint, typecheck, unit + contract tests, build
**Description:** `.github/workflows/ci.yml` runs on every PR and push to
`main`: install, ESLint, `tsc --noEmit`, Vitest unit tests
(`packages/cost-engine` first — deterministic formulas pinned), contract
tests (`packages/contracts`: JSON schemas for API request/response shapes),
migration up/down against ephemeral Postgres service, and full builds of
`apps/web` and `apps/api`. Failing any step blocks merge via FND-002's
required status checks.

**Acceptance criteria:**
- `.github/workflows/ci.yml` with jobs: `lint`, `typecheck`, `unit`
  (vitest), `contracts`, `migrations` (up+down on `postgres:16` service),
  `build-web`, `build-api`.
- `packages/contracts/` contains versioned JSON schemas (draft 2020-12) for
  the first two API shapes (`properties/autocomplete`,
  `properties/resolve`) — schemas are the shared truth for web + API + MCP.
- CI is green on the scaffold repo (placeholder tests allowed: one passing
  test per package, marked `// TODO(epic-01+)` — no fake coverage).
- Required-status-check wiring verified: a deliberately failing PR is blocked.

**Dependencies:** FND-002, FND-006
**Size:** M

---

### FND-009 — CD pipeline: PR previews, staging auto-deploy, gated prod, migrations in CD
**Description:** `.github/workflows/cd.yml` implements the deployment flow:
every PR gets a Static Web Apps preview environment (auto-cleanup on close);
merge to `main` auto-deploys to **staging** (SWA staging slot + Function App
staging slot + staging DB migrations run first); promotion **staging → prod**
requires Karan's manual approval via a GitHub Environment protection rule;
the migration step runs before the app deploy in each environment and fails
the pipeline on error.

**Acceptance criteria:**
- `.github/workflows/cd.yml` with `preview` (PR open/sync/close),
  `deploy-staging` (on `main` push), `deploy-prod` (manual `workflow_dispatch`
  or tag, gated by `production` environment approval rule naming Karan as
  required reviewer).
- Migration job uses the FND-006 framework runner with the DB connection
  string pulled from Key Vault via Managed Identity — no secrets in logs.
- SWA preview environments auto-close/delete when the PR closes.
- `docs/cd-runbook.md`: what deploys where, rollback procedure (redeploy
  previous SWA build + `down` migration only for expand-phase changes),
  and the explicit statement that prod deploys need Karan's approval each
  time (no standing auto-promote).

**Dependencies:** FND-004, FND-005, FND-007, FND-008
**Size:** M

---

### FND-010 — Secret management + rotation runbook (Key Vault + Managed Identity)
**Description:** Define the complete secret inventory and lifecycle: what lives
in Key Vault (Postgres admin + app credentials, Socrata app token, Postmark
server token, Stripe keys, Meta API key, magic-link signing secret), how
Functions/SWA resolve them at runtime (Managed Identity → Key Vault
references, never env-var plaintext), naming convention
(`feasly-<env>-<name>`), and a rotation runbook (who rotates, how often,
dual-secret overlap procedure for DB passwords, verification checklist).

**Acceptance criteria:**
- `docs/secrets.md`: full inventory table (secret name, owner, rotation
  cadence, blast radius if leaked), naming convention, and the rule that no
  secret ever appears in code, logs, or CI output (with the CI redaction
  check that enforces it).
- Rotation runbook covers Postgres password (dual-user overlap), Postmark
  token, Stripe keys, and magic-link signing secret rotation without
  invalidating in-flight links (overlap window ≥ 2× link TTL).
- Local dev uses `.env.example` + gitignored `.env` (documented in FND-011);
  CI uses OIDC → Key Vault, never repo secrets, for anything sensitive.

**Dependencies:** FND-004
**Size:** S

---

### FND-011 — Local dev: docker compose (Azurite + Postgres), env template, Calgary seed
**Description:** One-command local stack: `docker compose up` brings up
Postgres 16 and Azurite (Azure Storage emulator for Functions), with a
`db:seed` script inserting the Calgary `cities` row (`slug='calgary'`,
`timezone='America/Edmonton'`) plus a placeholder `cost_data_versions` row
marked `seed: true` (real params arrive with Karan's Sheet in M1). `.env.example`
documents every variable; README gets the 5-minute setup path.

**Acceptance criteria:**
- `infra/docker/docker-compose.yml` (Postgres 16 + Azurite), `infra/docker/README.md`.
- `.env.example` at repo root lists all required vars with safe defaults and
  comments (no real values).
- `infra/db/seeds/seed-calgary.ts` (npm script `db:seed`) inserts Calgary
  city row idempotently (re-runnable: `ON CONFLICT DO NOTHING`) and a seed
  cost-data version flagged non-production.
- `README.md` "Local setup" section: clone → `npm install` →
  `docker compose up -d` → `npm run db:migrate` → `npm run db:seed` →
  `npm run dev` all verified working from a clean checkout.

**Dependencies:** FND-002, FND-006
**Size:** S

---

### FND-012 — NEEDS-KARAN — Postmark account, domain sender signature, magic-link template
**Description:** Karan signs up for Postmark (manual — account ownership must
be his), adds the Feasly sending domain with a sender signature, and completes
DNS verification (SPF/DKIM records he adds at the registrar). Muse then stores
the server token in Key Vault (via Karan pasting it into the vault, never
chat), and creates the magic-link email template in Postmark (subject, body,
`{{magic_link}}` variable, plain-text part) with the transactional stream.

**Acceptance criteria:**
- Postmark account exists, owned by Karan; sending domain verified
  (SPF + DKIM green in Postmark UI).
- Server API token stored in Key Vault as `feasly-<env>-postmark-token`
  (Karan enters it; Muse verifies presence by name only, never the value).
- Template `magic-link` exists in the transactional stream with subject
  "Your Feasly report is ready", text+HTML bodies, and a single
  `{{magic_link}}` variable; test send to Karan's own address succeeds.
- Bounce/webhook handling noted as M4 scope (logged, not built here).

**Dependencies:** FND-010 (secret storage path), FND-014 (domain — can run in
  parallel with a temporary subdomain if domain is undecided; note the rework
  cost in the assumptions log)
**Size:** S
**Tags:** NEEDS-KARAN

---

### FND-013 — NEEDS-KARAN — Stripe account + test mode + webhook endpoint scaffold
**Description:** Karan creates the Stripe account (manual signup, his
business details) and enables test mode. Muse scaffolds the webhook receiver
`POST /api/v1/webhooks/stripe` in `apps/api`: raw-body signature verification
with the webhook secret from Key Vault, idempotent event logging to a new
`stripe_events` table (migration in this story), and a `200` for verified
events / `400` for bad signatures. No charges, products, or prices are
created in this epic — billing logic is a later milestone.

**Acceptance criteria:**
- Stripe account exists in test mode, owned by Karan; test publishable +
  secret keys in Key Vault (`feasly-<env>-stripe-pk/sk`, `...-stripe-whsec`).
- `apps/api/src/functions/stripe-webhook.ts` verifies `stripe-signature`
  header, logs every verified event idempotently to `stripe_events`
  (`event_id` unique, `type`, `payload jsonb`, `received_at`), returns 200;
  bad signature → 400 without logging the payload.
- Migration `00x-stripe-events` creates the table; CI covers the
  signature-verification unit test with Stripe's official test fixtures.
- A test-mode webhook delivery from the Stripe dashboard to the staging
  endpoint succeeds end-to-end (after staging exists via FND-009).

**Dependencies:** FND-010, FND-007 (migration pattern)
**Size:** M
**Tags:** NEEDS-KARAN

---

### FND-014 — NEEDS-KARAN — feasly.com availability check + purchase decision
**Description:** Karan checks `feasly.com` availability and price at his
registrar (and confirms fallback options: `feasly.ca` or a runner-up name if
taken/expensive). Purchase itself is a separate explicit approval — this story
only produces the decision. Once decided, the domain name parameterizes the
Bicep DNS module (FND-004) and the Postmark sender domain (FND-012).

**Acceptance criteria:**
- Decision recorded in `docs/domain-decision.md`: chosen domain (or "deferred"),
  registrar, annual cost, fallback if the primary is unavailable.
- If purchased (separate approval): DNS module parameter set, SWA custom
  domain + managed certificate plan documented.
- Explicit non-authorization restated: Muse does not purchase or transfer
  any domain.

**Dependencies:** none (can run any time; blocks FND-012's final sender
  domain and FND-004's DNS parameterization)
**Size:** S
**Tags:** NEEDS-KARAN

---

### FND-015 — NEEDS-KARAN — Confirm magic-link-only auth for V1
**Description:** Karan confirms the auth decision: magic-link email as the
**only** V1 login (no passwords, no OAuth in V1), and confirms or changes the
proposed 7-day link expiry from UX_FLOW S7. This locks the `magic_links`
table semantics (token_hash, expires_at, used_at) and the S8 re-issue flow
for the auth epic.

**Acceptance criteria:**
- Decision recorded in `docs/auth-decision.md`: magic-link-only confirmed
  (yes/no), link TTL (default 7 days unless Karan changes it), resend
  cooldown (60 s per UX_FLOW S7), max active links per user (assumption: 5,
  logged).
- If rejected: replacement auth approach captured as a new epic-00 story
  before any auth code is written.

**Dependencies:** none
**Size:** S
**Tags:** NEEDS-KARAN

---

### FND-016 — Schema reconciliation pass before baseline migration
**Description:** Before FND-007 writes the baseline migration, reconcile every
schema extension promised across the epics into a single `SCHEMA.md` —
nothing may appear in a story's acceptance criteria that isn't in the schema
first (decided USER_VALIDATION.md P1-4). Inventory and add: tenant billing
config fields (`stripe_customer_id`, `plan`, `card_on_file`, billing flags),
tenant agreement acceptance (`terms_accepted_at`, version), builder sessions
(admin auth), `embed_relay_codes` (single-use codes — separate table from
`magic_links`), commission + attribution columns (`commission_invoices`,
`attribution_state` per epic 06), permit-match fields (`permits`,
`contract_value_cents`, `value_source` enum, `commission_invoice_id` link),
`leads.timeline` (hot/warm/cold input), `leads.phone` **nullable** (phone is
optional at the gate — explicit alter), privacy columns (`consent_log`,
`erase_requests`). The reconciliation is a reviewed doc diff, then FND-007
generates the migration from the final `SCHEMA.md`.

**Acceptance criteria:**
- `SCHEMA.md` has one canonical table list; every table/column referenced by
  any epic's acceptance criteria exists there (CI grep check on table names
  in story files vs schema — warn on miss).
- Baseline migration `db/migrations/0001_baseline.sql` is generated FROM the
  reconciled schema (dbmate up against a scratch Postgres), not hand-written
  from memory.
- `leads.phone` is nullable in the migration; `leads.status` CHECK matches
  `('new','contacted','quoting','won','lost')`.

**Dependencies:** FND-006 (dbmate decision); all epics' schema-touching
stories feed requirements into it.
**Size:** M

---

## Assumptions log
1. **Postgres pg 16** on Flexible Server; Burstable B1ms is sufficient for
   MVP — assumption validated by low expected traffic; upgrade is a SKU
   parameter change, not a migration.
2. **npm workspaces** as the monorepo package manager (Karan's requested
   pattern; matches CODING_PATTERNS.md — decided USER_VALIDATION.md P0-H).
3. **Vitest** for unit tests, **ESLint + Prettier** for lint/format (simplest
   TS-native choices; no Jest/Babel weight).
4. Zone-redundant HA **off** in all environments for M0 cost reasons; prod HA
   is a conscious later decision, not an oversight.
5. FND-012 can start with a temporary sending subdomain if FND-014 is
   undecided; switching the sender domain later requires re-verification —
   flagged to Karan as a reason to decide the domain early.
6. GitHub **organization** is recommended over a personal repo for future
   builder workspaces, but a personal private repo is acceptable for M0 and
   does not block anything.
7. Max 5 active magic links per user (FND-015 default) — prevents link spam,
   cheap to change.
8. `stripe_events` table is added now (FND-013) even though billing logic is
   later — cheap, and the webhook must be idempotent from day one.

## Open questions
- **NEEDS-KARAN:** GitHub org vs personal account for the `feasly` repo?
- **NEEDS-KARAN:** Azure — existing subscription (which?) or a fresh one for
  Feasly?
- **NEEDS-KARAN:** Confirm magic-link-only V1 + link TTL (7 days proposed)?
- **NEEDS-KARAN:** feasly.com availability/price/fallback — and separate
  explicit approval if purchasing?
- **NEEDS-KARAN:** Postmark + Stripe signups are manual — ok to proceed, and
  whose business entity goes on the Stripe account (Elite Craft vs new)?
- Who is the second reviewer if Karan is unavailable — is single-approver
  (Karan only) acceptable for M0, or do we allow self-approved merges for
  docs-only changes?
- Should staging share the dev Postgres (cheaper) or get its own B1ms
  (isolation)? Recommendation: own B1ms — ~CA$25/mo is cheap insurance
  against staging migrations breaking dev. **NEEDS-KARAN** only insofar as
  it affects the Azure bill.
