# GitHub Actions → Azure OIDC setup runbook (FND-005)

How CI/CD authenticates to Azure without any long-lived client secrets:
a **user-assigned managed identity** in the Feasly resource group, federated
credentials trusting GitHub Actions OIDC tokens, and a **Contributor** role
assignment scoped to the resource group.

> NEEDS-KARAN: creating federated credentials touches Azure AD and must be
> run by Karan (or with him watching). Everything else here is documented
> read-only-safe until step 3.
>
> No secrets are created, stored, or shown anywhere in this runbook.

## 0. Prerequisites

```bash
az login
az account set --subscription 9b7d7805-311a-4e4f-ac48-5d281d7e1185
az account show --query '{name:name, id:id, tenantId:tenantId}' -o table

# The resource group must already exist:
az group create --name rg-feasly-dev --location canadacentral
```

## 1. Create the user-assigned managed identity

```bash
az identity create \
  --name feasly-github-oidc \
  --resource-group rg-feasly-dev \
  --location canadacentral
```

Capture the identity's IDs for the next steps:

```bash
IDENTITY_PRINCIPAL_ID=$(az identity show \
  --name feasly-github-oidc \
  --resource-group rg-feasly-dev \
  --query principalId -o tsv)
IDENTITY_CLIENT_ID=$(az identity show \
  --name feasly-github-oidc \
  --resource-group rg-feasly-dev \
  --query clientId -o tsv)
echo "principalId=$IDENTITY_PRINCIPAL_ID"
echo "clientId=$IDENTITY_CLIENT_ID"
```

## 2. Create the federated credentials (Azure AD — Karan runs this)

Issuer: `https://token.actions.githubusercontent.com`
Audience: `api://AzureADTokenExchange`

```bash
# Trust pushes / workflow runs on main
az identity federated-credential create \
  --name feasly-main \
  --identity-name feasly-github-oidc \
  --resource-group rg-feasly-dev \
  --issuer https://token.actions.githubusercontent.com \
  --subject repo:ksingh31/feasly:ref:refs/heads/main \
  --audiences api://AzureADTokenExchange

# Trust pull-request runs (what-if on infra/** changes)
az identity federated-credential create \
  --name feasly-pr \
  --identity-name feasly-github-oidc \
  --resource-group rg-feasly-dev \
  --issuer https://token.actions.githubusercontent.com \
  --subject repo:ksingh31/feasly:pull_request \
  --audiences api://AzureADTokenExchange
```

Verify:

```bash
az identity federated-credential list \
  --identity-name feasly-github-oidc \
  --resource-group rg-feasly-dev \
  --query '[].{name:name, subject:subject, issuer:issuer}' -o table
```

> Note: FND-005 also lists an `:environment:staging` federated credential for
> the staging-deploys environment. Add it later with
> `--subject repo:ksingh31/feasly:environment:staging` once the `staging`
> GitHub Environment exists (FND-009).

## 3. Grant Contributor scoped to the resource group (least privilege)

```bash
az role assignment create \
  --assignee "$IDENTITY_PRINCIPAL_ID" \
  --role Contributor \
  --resource-group rg-feasly-dev \
  --description "Feasly GitHub OIDC identity: CD deployments (FND-005)"
```

The Bicep template itself grants this identity **Key Vault Secrets Officer**
on the vault at deploy time (in-template role assignment), so no separate KV
role grant is needed here.

## 4. Wire the workflow (`azure/login@v2`)

In the GitHub repo, set these as **variables** (Settings → Variables — not
secrets; none of them are secret):

| Variable | Value |
|---|---|
| `AZURE_CLIENT_ID` | `$IDENTITY_CLIENT_ID` (from step 1) |
| `AZURE_TENANT_ID` | `e9b8f029-1138-4a0f-86c4-88c4a84d0d68` |
| `AZURE_SUBSCRIPTION_ID` | `9b7d7805-311a-4e4f-ac48-5d281d7e1185` |

Workflow step:

```yaml
- name: Azure login (OIDC)
  uses: azure/login@v2
  with:
    client-id: ${{ vars.AZURE_CLIENT_ID }}
    tenant-id: ${{ vars.AZURE_TENANT_ID }}
    subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
```

The job needs `permissions: id-token: write` for the OIDC token exchange.

## 5. Verify (dry run, no deployment)

On a test branch, run a workflow step with only:

```bash
az account show --query '{name:name, id:id}' -o table
```

Success = OIDC trust works end to end. Per FND-005 acceptance criteria, this
verification must pass before any deployment workflow is enabled.

## Repeat per environment

Run steps 1–4 for `rg-feasly-stg` and `rg-feasly-prod` (naming:
`feasly-github-oidc` identity per RG, same subjects) before CD targets them.
Prod wiring happens only when Karan approves the first prod deploy.
