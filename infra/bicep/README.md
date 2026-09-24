# Azure infrastructure (Bicep) — FND-004

> Authored, not applied. Every `az deployment` command here runs as `what-if`
> until Karan approves an apply (per story). **DO-NOT-RUN**
> `az deployment group create` against staging or prod without his explicit
> approval — for each deploy.

## Standing rules

- **Subscription / tenant:** "Azure subscription 1"
  (`9b7d7805-311a-4e4f-ac48-5d281d7e1185`), tenant Default Directory
  (`e9b8f029-1138-4a0f-86c4-88c4a84d0d68`). All resources in **canadacentral**
  **except the Static Web App**, which Azure does not offer in Canada Central
  — it deploys to **westus2** (closest available region; `swaLocation` param).
  Data plane (Postgres, Functions, Key Vault, Storage) stays in Canada.
  (PIPEDA residency).
- **Billing rule (standing, 2026-09-23): stay on the FREE tier — never
  change/upgrade the subscription type** without Karan's explicit approval,
  each time. Every SKU in this template was chosen for free/cheap operation:
  SWA **Free**, Functions **Flex Consumption FC1**, Postgres Flexible Server
  **Burstable B1ms** (B2s in prod only), Key Vault **Standard**, Storage
  **Standard_LRS**.
- **Secrets:** `postgresAdminPassword` is a `@secure()` parameter. The
  template writes it into Key Vault as `feasly-<env>-postgres-admin` and the
  Function App reads it back via a Key Vault reference
  (`@Microsoft.KeyVault(SecretUri=...)`) — the password value never appears
  in app settings, outputs, logs, or any committed file. No secret values in
  Bicep or `.bicepparam` files, ever.

## Layout

```
infra/bicep/
  main.bicep                    # RG-scope entry; wires all modules
  environments/
    dev.bicepparam              # B1ms, 7-day backup retention
    staging.bicepparam          # B1ms, 7-day backup retention
    prod.bicepparam             # B2s, 30-day backup retention (param change, not a migration)
  modules/
    static-web-app.bicep        # SWA, SKU Free, no custom domain
    function-app.bicep          # Flex Consumption FC1 plan + Function App (Node 22)
    postgres.bicep              # PG16 Flexible Server, Burstable, one `feasly` database
    key-vault.bicep             # Standard, RBAC authorization, soft delete
    monitoring.bicep            # Log Analytics + workspace-based App Insights
    storage.bicep               # StorageV2, `tenant-assets` + `deployment` containers,
                                # lifecycle rule: dispute-evidence -> archive @90d, delete @7yr
    dns.bicep                   # AUTHOR ONLY — not wired into main.bicep (no domain owned yet, FND-014)
```

## Naming

- Resource groups (created outside Bicep): `rg-feasly-dev`, `rg-feasly-stg`,
  `rg-feasly-prod` (environment short names: `dev`, `stg`, `prod`).
- Globally-unique resource types take a 6-char hash suffix from the resource
  group ID, e.g. `feasly-dev-web-<hash>` (SWA), `feasly-dev-api-<hash>`
  (Function App), `feasly-dev-pg-<hash>` (Postgres), `feasly-dev-kv-<hash>`
  (Key Vault), `feaslydev<hash>` (Storage). Regionally/RG-scoped names
  (`feasly-dev-plan`, `feasly-dev-ai`, `feasly-dev-law`) carry no suffix.

## What-if (manual, read-only)

```bash
# Log in read-only check (no resources touched)
az account show --query '{name:name, id:id}' -o table

# Dev what-if — password comes from your shell env or a prompt; never commit it.
# Inline --parameters override the .bicepparam value.
az deployment group what-if \
  --resource-group rg-feasly-dev \
  --template-file infra/bicep/main.bicep \
  --parameters infra/bicep/environments/dev.bicepparam \
  --parameters postgresAdminPassword='<from-Key-Vault-or-generated>'
```

Swap `dev` for `staging` / `prod` to what-if those environments (staging and
prod what-if are read-only and safe; creating anything there is not).

## Future apply (DO-NOT-RUN without Karan's explicit approval)

```bash
# DEV ONLY until approved — same shape for staging/prod when Karan signs off.
az deployment group create \
  --resource-group rg-feasly-dev \
  --template-file infra/bicep/main.bicep \
  --parameters infra/bicep/environments/dev.bicepparam \
  --parameters postgresAdminPassword='<from-Key-Vault-or-generated>'
```

Staging and prod applies follow the CD gates in FND-009 (staging auto on
`main` merge, prod via the `production` GitHub Environment with manual
approval). Each prod deploy needs Karan's approval — no standing auto-promote.

## Deploy-time notes

- **Flex Consumption RBAC propagation:** the Function App's system-assigned
  identity gets "Storage Blob Data Contributor" on the storage account in the
  same deployment. If the first deploy fails on deployment-storage access,
  re-run — this is Azure RBAC propagation, not a template bug.
- **Postgres public access** is enabled in dev/staging with the
  `AllowAzureServices` firewall rule (0.0.0.0–0.0.0.0) for MVP simplicity;
  private-access hardening is a later story.
- **Zone-redundant HA is off** in all environments (conscious M0 cost
  decision, FND-004).
- **DNS:** `modules/dns.bicep` is authored but intentionally NOT referenced
  from `main.bicep`. Wire it in only after FND-014 (domain purchase) resolves.
- **OIDC:** GitHub Actions deploy via OIDC federation — see
  `docs/oidc-setup.md`. The deployer identity receives "Key Vault Secrets
  Officer" on the vault (in-template role assignment) so CI can write/read
  secrets; it must also hold **Contributor** on the resource group (runbook).
