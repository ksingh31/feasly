# CD Runbook — Feasly (FND-009)

Pipeline definition: `.github/workflows/cd.yml`.
Merge gate: `ci.yml` job `build` (required status check `build` on `main`).

## What deploys where

| Trigger | Job | Target | What happens |
|---|---|---|---|
| PR opened / synchronized / reopened (into `main`) | `preview` | SWA preview environment | Static Web Apps deploys `apps/web` via `Azure/static-web-apps-deploy@v1` (`action: "upload"`). API build skipped (`skip_api_build: true`) — the placeholder web page deploys with no build step. Each PR gets its own ephemeral preview URL. |
| PR closed | `preview-close` | SWA preview environment | `Azure/static-web-apps-deploy@v1` with `action: "close"` — the preview environment is deleted. |
| Push to `main` | `deploy-dev` | **dev** (auto) | 1. Checkout. 2. `azure/login@v2` via OIDC (permissions `id-token: write, contents: read`). 3. Read Postgres admin password from Key Vault (KV name discovered via `az keyvault list -g rg-feasly-dev`, falling back to `feasly-dev-kv`), masked with `::add-mask::`. 4. `az deployment group what-if` against `infra/bicep/main.bicep` + `infra/bicep/environments/dev.bicepparam` — what-if errors fail the pipeline. 5. `az deployment group create` (same files + `postgresAdminPassword`). 6. Deploy web via SWA action. 7. Deploy API via `Azure/functions-action@v1` (`app-name: feasly-dev-api`, `package: apps/api`). 8. Smoke test: hostnames derived from `az staticwebapp show` / `az functionapp show`; curl SWA root and `https://<func>/api/health` and expect HTTP 200 (3 attempts, 15 s apart). |
| Manual `workflow_dispatch` → target `staging` | `deploy-staging` | **staging** (`environment: staging`) | Same Bicep what-if + deploy shape, targeting `rg-feasly-staging` and `infra/bicep/environments/staging.bicepparam`. **Staging infrastructure does not exist yet** — this job is intentionally manual and currently stops after Bicep; SWA/Functions/app deploys are wired once staging resources are provisioned. |
| Manual `workflow_dispatch` → target `production` | `deploy-prod` | **production** (`environment: production`) | Scaffolding only until Karan provisions prod infra and approves the first release. **Prod deploys need Karan's approval every time** — see below. |

Workflow-level `concurrency` (`group: feasly-cd`, `cancel-in-progress: false`):
only one CD run executes at a time; overlapping runs queue, never cancel an
in-flight deploy.

### Credentials inventory

- **GitHub Variables** (not secrets): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
  `AZURE_SUBSCRIPTION_ID` — consumed by `azure/login@v2` for OIDC.
- **GitHub Secret**: `FEASLY_SWA_DEPLOY_TOKEN` — the Static Web Apps deployment
  token. This is the one allowed long-lived secret (standard SWA practice).
- **Key Vault** (`feasly-dev-kv`, discovered at deploy time): `feasly-dev-postgres-admin`
  — read at deploy time, masked, never echoed, never stored. No other secrets.

### Environments

- `staging` and `production` GitHub environments must have required-reviewer
  protection rules. `production` names Karan as required reviewer: **every
  prod deploy needs Karan's approval each time — no auto-promote, no standing
  approval, no tag-triggered release.**
- `deploy-staging` / `deploy-prod` run on `workflow_dispatch` only (choice
  input `target`), never on push/PR.

## Rollback procedure

### Web (Static Web App)
Re-run the SWA deploy action against the prior known-good commit:
checkout that commit (or run the `preview`/`deploy-dev` SWA step from it) and
deploy with `action: "upload"`. SWA keeps deployment history in the Azure
portal; the fastest rollback is redeploying the previous build from the
`main` history. For PR previews: closing/reopening the PR rebuilds the
preview from the PR head.

### API (Function App)
Re-run the Functions deploy step (`Azure/functions-action@v1`,
`package: apps/api`) from the prior known-good commit. The function app
itself is redeployed in place — there are no slots in dev; keep it that way
until staging/prod slots exist.

### Database migrations
Once migrations exist (FND-006/FND-007, dbmate):
1. **Migration runs before the app deploy** in every environment, and a
   migration failure fails the pipeline.
2. Rollback policy: redeploy the previous app build; run `dbmate down` **only**
   for expand-phase changes (new tables/columns that the old app does not
   depend on). Never roll back a contract-phase migration (column/table
   removal) — forward-fix with a new migration instead (expand/migrate/contract
   pattern, see `infra/db/MIGRATION_PROCESS.md`).
3. Migrations connect via Managed Identity; connection strings come from
   Key Vault. No secrets in logs.

### Infra (Bicep)
`what-if` output is the pre-deploy diff. If a Bicep deploy causes a bad state,
re-run `az deployment group create` from the last known-good commit's Bicep
files — Bicep is declarative, so re-applying the previous template is the
rollback. Never hand-edit resources in the portal to "fix" a bad deploy;
fix the Bicep and re-run.

## Deviation from FND-009 (logged for reconciliation)

The foundation story specifies: PR previews → main merge auto-deploys
**staging** → manual promotion staging → prod. The pipeline as authored
sends `main` pushes to **dev** (auto), and makes both staging and prod
manual `workflow_dispatch` jobs. Rationale: staging/prod Azure infrastructure
does not exist yet, and Karan's standing rule is that nothing deploys to a
production-grade environment without his explicit approval each time. Revisit
the staging-auto-deploy question when staging infra is provisioned.

## Troubleshooting quick reference

- **Preview deploys but shows a 404**: the SWA action uploaded `apps/web`;
  confirm `apps/web/index.html` exists at the repo path the action used.
- **OIDC login fails**: check the federated credential subjects in
  `docs/oidc-setup.md` and that the three `AZURE_*` Variables are set.
- **what-if fails**: read the error, fix the Bicep, push to a PR — the
  preview/smoke path never touches Azure, so iteration is cheap.
- **Smoke test flakes on `/api/health`**: Flex Consumption cold starts are
  1–3 s; the check retries 3×. Persistent failure means the Functions deploy
  step failed — check its logs before re-running.
- **`::add-mask::` note**: the Postgres password is masked in logs, but
  avoid passing it on command lines where possible; here it is required by
  the Bicep `postgresAdminPassword` secure parameter and is never printed.
