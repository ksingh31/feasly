// Feasly — infrastructure entry point (resource-group scope).
// Deploys: Static Web App (Free), Function App (Flex Consumption FC1), Postgres
// Flexible Server 16 (Burstable), Key Vault (RBAC), App Insights + Log Analytics,
// StorageV2 account. DNS zone module is authored but NOT wired in (no domain yet).
//
// Usage: what-if / create against rg-feasly-<env>. See infra/bicep/README.md.
// Target: subscription "Azure subscription 1" (9b7d7805-311a-4e4f-ac48-5d281d7e1185),
// region canadacentral everywhere.
targetScope = 'resourceGroup'

@description('Environment name: dev, staging, or prod')
@allowed([
  'dev'
  'staging'
  'prod'
])
param environment string = 'dev'

@description('Azure region (fixed for PIPEDA residency)')
param location string = 'canadacentral'

@description('Static Web App region — SWA is NOT available in Canada Central (Azure limitation); westus2 is the closest region. Data plane (Postgres, Functions, KV) stays in Canada.')
param swaLocation string = 'westus2'

@description('Postgres admin password — NEVER logged or output; stored in Key Vault')
@secure()
param postgresAdminPassword string

@description('Email provider for transactional email (magic links, lead notifications)')
@allowed([
  'log'
  'postmark'
  'acs'
])
param emailProvider string = 'log'

@description('Azure Communication Services connection string — NEVER logged or output; stored in Key Vault. Empty = not configured (app fails closed on send).')
@secure()
param acsConnectionString string = ''

@description('Google Sheet ID for the hourly leads sync (admin/04). PLACEHOLDER — Karan shares his Sheet with the service account and provides the ID. Empty = sync disabled (fail-closed).')
param sheetsSheetId string = ''

@description('Google service-account email for the Sheets sync (admin/04). PLACEHOLDER until the service account is provisioned. Empty = sync disabled.')
param sheetsServiceAccountEmail string = ''

@description('Google service-account private key (PEM) for the Sheets sync — NEVER logged or output; stored in Key Vault. PLACEHOLDER until Karan provisions the service account. Empty = not configured.')
@secure()
param sheetsServiceAccountPrivateKey string = ''

@description('Custom domain (empty until FND-014 resolves the domain purchase)')
param domainName string = ''

@description('Ops alert email for metric alert action group (BE8-001). Standing test email until Karan names the ops inbox.')
param opsAlertEmail string = 'karanbirsingh667@gmail.com'

@description('Postgres Flexible Server SKU (Burstable tier)')
@allowed([
  'Standard_B1ms'
  'Standard_B2s'
])
param postgresSkuName string = 'Standard_B1ms'

@description('Postgres point-in-time-restore backup retention, days')
@minValue(7)
@maxValue(35)
param postgresBackupRetentionDays int = 7

@description('Principal type of the deployer identity (CI uses the OIDC managed identity)')
// --- Naming ---
// Globally-unique resource types (SWA, Function App, Postgres, Key Vault, Storage)
// get a 6-char hash suffix from the resource group ID; regional/RG-scoped ones do not.
var envShort = environment == 'staging' ? 'stg' : environment
var token = take(uniqueString(resourceGroup().id), 6)
var swaName = 'feasly-${envShort}-web-${token}'
var functionAppName = 'feasly-${envShort}-api-${token}'
var functionPlanName = 'feasly-${envShort}-plan'
var postgresName = 'feasly-${envShort}-pg-${token}'
var keyVaultName = 'feasly-${envShort}-kv-${token}'
var aiName = 'feasly-${envShort}-ai'
var lawName = 'feasly-${envShort}-law'
var storageName = toLower('feasly${envShort}${take(uniqueString(resourceGroup().id), 8)}')

var postgresAdminLogin = 'feaslyadmin'
var postgresSecretName = 'feasly-${environment}-postgres-admin'
var postgresPasswordSecretUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${postgresSecretName}'
var acsSecretName = 'feasly-${environment}-acs-connection-string'
var acsConnectionStringSecretUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${acsSecretName}'
var sheetsPrivateKeySecretName = 'feasly-${environment}-sheets-service-account-key'
var sheetsPrivateKeySecretUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${sheetsPrivateKeySecretName}'
var unsubscribeSecretName = 'feasly-${environment}-unsubscribe-token-secret'
var unsubscribeTokenSecretUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${unsubscribeSecretName}'
// AI summary (narrative worker): Karan provisions the Gemini API key in Key
// Vault himself (this secret is NOT deployed by Bicep — a Bicep-deployed
// secret would overwrite his value). The URI below only references it; the
// secret must exist in the vault before the app first resolves the
// Key Vault reference at startup.
var narrativeSecretName = 'feasly-${environment}-narrative-api-key'
var narrativeApiKeySecretUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${narrativeSecretName}'

// Fallback narrative provider (Groq): Karan provisioned feasly-dev-groq-api-key
// in the dev vault himself (Bicep only references it, never writes it). Empty
// in other environments = the Groq step is skipped gracefully.
var groqSecretName = 'feasly-${environment}-groq-api-key'
var groqApiKeySecretUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${groqSecretName}'

// Stripe billing (billing/02, BILL-02): Karan provisions the Stripe TEST-mode
// keys in Key Vault himself (this is NOT deployed by Bicep — a Bicep-deployed
// secret would overwrite his value). The URIs below only reference them; the
// secrets must exist in the vault before the app first resolves the Key Vault
// references at startup. Until then the settings stay empty and billing
// stays dormant (BILLING_NOT_CONFIGURED). Config enforces test keys outside
// production, so no real charge is possible in dev.
var stripeSecretKeyName = 'feasly-${environment}-stripe-secret-key'
var stripeSecretKeySecretUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${stripeSecretKeyName}'
var stripeWebhookSecretName = 'feasly-${environment}-stripe-webhook-secret'
var stripeWebhookSecretSecretUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${stripeWebhookSecretName}'

// Microsoft Entra External ID sign-in (admin/builder, auth/02): the tenant,
// app registrations, and user flow are provisioned once in the portal (see
// docs/auth/entra-manual-changes.md) — Entra External ID resources are not
// Bicep-able. Bicep only wires the resulting identifiers into the Function
// App's app settings. The Graph client secret is provisioned in Key Vault
// under its exact name below (created in the portal during tenant setup) —
// the URI below only references it; Bicep never writes the raw value. The
// secret must exist in the vault before the app first resolves the Key Vault
// reference at startup (only Graph provisioning reads it; the sign-in
// callback itself does not).
var entraGraphClientSecretName = 'feasly-entra-graph-client-secret'
var entraGraphClientSecretUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${entraGraphClientSecretName}'

// `feasly-web` client secret for the admin sign-in token exchange. The
// callback redirect URI is registered on the "Web" platform, so the token
// endpoint treats the backend as a confidential client and rejects the
// exchange with HTTP 401 invalid_client when the secret is absent. The
// secret is provisioned in Key Vault under its exact name below (created in
// the portal on the app registration's Certificates & secrets blade) — the
// URI below only references it; Bicep never writes the raw value. Dev-only
// until Karan provisions the tenant identifiers for other environments.
var entraClientSecretName = 'feasly-entra-client-secret'
var entraClientSecretUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${entraClientSecretName}'

// Builder-portal Entra External ID sign-in (auth/05): separate app
// registration from the admin `feasly-web` app (builder sign-in must never
// mint an admin session). Provisioned 2026-09-28 via Microsoft Graph
// (Karan-authorized one-time setup; see the dated entry in
// ~/workspace/feasly/docs/auth/entra-manual-changes.md): app
// `feasly-builder-web`, client ID 5e87b5ee-7ff7-4a70-a056-b0bab5715622.
// The user flow is the existing `feasly-signup-signin` (tenant-level,
// not per-app). The client secret lives in Key Vault under its exact name
// here — Bicep references it, never the raw value. Other environments keep
// the identifiers empty and the builder callback fails closed (503) naming
// the missing variables.
var builderEntraClientSecretName = 'feasly-builder-entra-client-secret'
var builderEntraClientSecretUri = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${builderEntraClientSecretName}'

// --- Monitoring ---
module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    name: aiName
    workspaceName: lawName
    location: location
  }
}

// --- Key Vault ---
module keyVault 'modules/key-vault.bicep' = {
  name: 'key-vault'
  params: {
    name: keyVaultName
    location: location
  }
}

// --- Storage ---
module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    name: storageName
    location: location
  }
}

// --- Postgres ---
module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    name: postgresName
    location: location
    adminLogin: postgresAdminLogin
    adminPassword: postgresAdminPassword
    skuName: postgresSkuName
    backupRetentionDays: postgresBackupRetentionDays
    storageSizeGB: 32
  }
}

// --- Static Web App ---
module staticWebApp 'modules/static-web-app.bicep' = {
  name: 'static-web-app'
  params: {
    name: swaName
    location: swaLocation
  }
}

// --- Azure Communication Services email (ADM-10) ---
// Free to provision; billed per email sent (negligible at magic-link
// volumes — free-tier safe). Dev gets a provisioned ACS + Azure-managed
// domain; other environments use the deploy-time acsConnectionString param.
// The connection string is written straight into Key Vault via the module
// output — it never appears in outputs, logs, or app settings.
module communication 'modules/communication.bicep' = if (environment == 'dev') {
  name: 'communication'
  params: {
    envShort: envShort
    token: token
  }
}

// --- Function App (Flex Consumption) ---
module functionApp 'modules/function-app.bicep' = {
  name: 'function-app'
  params: {
    name: functionAppName
    planName: functionPlanName
    location: location
    deploymentStorageContainerUrl: storage.outputs.deploymentContainerUrl
    storageAccountName: storage.outputs.name
    appInsightsConnectionString: monitoring.outputs.connectionString
    postgresHost: postgres.outputs.fqdn
    postgresDatabase: postgres.outputs.databaseName
    postgresUser: postgresAdminLogin
    postgresPasswordSecretUri: postgresPasswordSecretUri
// Dev uses the provisioned ACS (module above); other environments use
    // the deploy-time emailProvider param (default 'log', fail-closed).
    emailProvider: environment == 'dev' ? 'acs' : emailProvider
    acsConnectionStringSecretUri: (environment == 'dev' || !empty(acsConnectionString)) ? acsConnectionStringSecretUri : ''
    // Sender identity for dev: the provisioned Azure-managed domain sender
    // (ACS requires a verified-domain sender). Empty elsewhere → config default.
    // PLACEHOLDER (ADM-10): Azure-managed DoNotReply sender for overnight
    // verification only — swap for Karan's custom-domain sender when he
    // provides one.
    emailFromAddress: environment == 'dev' ? communication.outputs.senderAddress : ''
    // Magic-link URLs in emails must open on the live site (ADM-10), not the
    // feasly.example config default.
    appBaseUrl: 'https://${staticWebApp.outputs.hostname}'
    // CORS allowlist for the in-app middleware (ADM-10): the web app calls
    // the API cross-origin (SWA Free SKU rejects linked backends). The
    // middleware is the single CORS source — no platform-level siteConfig.cors.
    // Allowed: the live SWA hostname + local dev. Never '*' — credentials
    // are required.
    corsAllowedOrigins: [
      'https://${staticWebApp.outputs.hostname}'
      'http://localhost:4200'
    ]
    // admin/04 — Sheets sync placeholders (fail closed until Karan provisions
    // the service account).
    sheetsSheetId: sheetsSheetId
    sheetsServiceAccountEmail: sheetsServiceAccountEmail
    sheetsServiceAccountPrivateKeySecretUri: empty(sheetsServiceAccountPrivateKey) ? '' : sheetsPrivateKeySecretUri
    // email/03 — one-click unsubscribe token HMAC secret. Bootstrapped in
    // Key Vault below; the app fails closed (503) on
    // /api/v1/unsubscribe/{token} without it.
    unsubscribeTokenSecretUri: unsubscribeTokenSecretUri
    // AI summary (narrative worker): dev-only until Karan provisions the key
    // in the other vaults. Elsewhere the settings stay empty and the app
    // keeps its log-provider default.
    narrativeProvider: environment == 'dev' ? 'openai-compatible' : 'log'
    narrativeApiKeySecretUri: environment == 'dev' ? narrativeApiKeySecretUri : ''
    narrativeEndpoint: environment == 'dev' ? 'https://generativelanguage.googleapis.com/v1beta/openai/' : ''
    narrativeModels: environment == 'dev' ? 'gemini-3.8-flash' : ''
    // Fallback narrative provider (Groq): endpoint/models fall back to
    // the app config defaults (empty = setting omitted). The API key is
    // a Key Vault reference in dev (Karan provisioned
    // feasly-dev-groq-api-key himself); empty elsewhere = the Groq step
    // is skipped gracefully and the static guide remains the last resort.
    narrativeFallbackEndpoint: ''
    narrativeFallbackApiKeySecretUri: environment == 'dev' ? groqApiKeySecretUri : ''
    narrativeFallbackModels: ''
    // Stripe billing (billing/02, BILL-02): dev-only until Karan provisions
    // the test-mode keys in the vault. Elsewhere the settings stay empty
    // and billing stays dormant (BILLING_NOT_CONFIGURED).
    stripeSecretKeySecretUri: environment == 'dev' ? stripeSecretKeySecretUri : ''
    stripeWebhookSecretUri: environment == 'dev' ? stripeWebhookSecretSecretUri : ''
    // Microsoft Entra External ID sign-in (auth/02): dev-only until Karan
    // provisions the tenant identifiers for other environments. Elsewhere
    // the settings stay empty and the backend callback fails closed (503)
    // naming the missing variables. These identifiers are non-secret (they
    // also ship in the public web app-config.json).
    entraTenantSubdomain: environment == 'dev' ? 'feaslyext' : ''
    entraTenantId: environment == 'dev' ? 'e8f46aab-2491-4389-8e39-ae78ee12db6a' : ''
    entraClientId: environment == 'dev' ? '8d5e842c-c97d-490c-9437-5c77bd9104df' : ''
    entraUserFlow: environment == 'dev' ? 'feasly-signup-signin' : ''
    entraIssuerDomain: environment == 'dev' ? 'feaslyext.onmicrosoft.com' : ''
    entraGraphClientId: environment == 'dev' ? '2fe45e0e-a3ae-4695-93db-eaf1a15ba4d0' : ''
    entraGraphClientSecretUri: environment == 'dev' ? entraGraphClientSecretUri : ''
    entraClientSecretUri: environment == 'dev' ? entraClientSecretUri : ''
    // Builder-portal Entra External ID sign-in (auth/05): dev-only until Karan
    // provisions the builder tenant identifiers for other environments.
    // Elsewhere the settings stay empty and the builder callback fails
    // closed (503) naming the missing variables. These identifiers are
    // non-secret (they also ship in the public web app-config.json).
    builderEntraTenantSubdomain: environment == 'dev' ? 'feaslyext' : ''
    builderEntraTenantId: environment == 'dev' ? 'e8f46aab-2491-4389-8e39-ae78ee12db6a' : ''
    builderEntraClientId: environment == 'dev' ? '5e87b5ee-7ff7-4a70-a056-b0bab5715622' : ''
    builderEntraUserFlow: environment == 'dev' ? 'feasly-signup-signin' : ''
    builderEntraClientSecretUri: environment == 'dev' ? builderEntraClientSecretUri : ''
    // admin/06 — daily Postgres backup freshness probe (backup_missed).
    // Enabled per environment; the Function App's managed identity gets
    // Reader on the resource group (see function-app.bicep).
    backupCheckEnabled: true
    backupCheckSubscriptionId: subscription().subscriptionId
    backupCheckResourceGroup: resourceGroup().name
    backupCheckServerName: postgres.outputs.serverName
  }
  // The dev ACS secret (below) must exist before the app first resolves its
  // Key Vault references at startup. Skipped automatically when the
  // conditional secret is not deployed (non-dev). The unsubscribe HMAC
  // secret (email/03) likewise must exist before startup resolves it. The
  // narrative API key secret (feasly-<env>-narrative-api-key) is provisioned
  // by Karan in the portal, not by Bicep — it must exist in the vault before
  // this deployment goes live, otherwise the dev app fails to resolve the
  // Key Vault reference at startup.
  dependsOn: [
    acsDevConnectionStringSecret
    unsubscribeTokenSecret
  ]
}

// --- Metric alerts (BE8-001): 5xx rate + poison queue depth ---
module alerts 'modules/alerts.bicep' = {
  name: 'alerts'
  params: {
    namePrefix: 'feasly-${envShort}'
    logAnalyticsWorkspaceId: monitoring.outputs.workspaceId
    workspaceLocation: location
    opsAlertEmail: opsAlertEmail
  }
}

// --- Key Vault secret: Postgres admin password ---
// The @secure() parameter is written straight into the vault; it never appears
// in outputs, logs, or app settings.
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource postgresAdminSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: postgresSecretName
  properties: {
    value: postgresAdminPassword
  }
  // The module above creates the vault; `existing` only reads it, so the
  // ordering dependency must be explicit.
  dependsOn: [
    keyVault
  ]
}

// --- Key Vault secret: ACS connection string (deploy-time param) ---
// Only created when acsConnectionString is provided at deploy time AND the
// environment is not dev (dev uses the provisioned ACS module below — the
// two paths are mutually exclusive on the same secret name). The @secure()
// parameter is written straight into the vault; it never appears in outputs,
// logs, or app settings. The Function App reads it via a Key Vault reference
// (see function-app.bicep).
resource acsConnectionStringSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(acsConnectionString) && environment != 'dev') {
  parent: kv
  name: acsSecretName
  properties: {
    value: acsConnectionString
  }
  dependsOn: [
    keyVault
  ]
}

// --- Key Vault secret: ACS connection string (provisioned, dev) ---
// Written from the communication module output — the value never appears in
// outputs, logs, or app settings.
resource acsDevConnectionStringSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (environment == 'dev') {
  parent: kv
  name: acsSecretName
  properties: {
    value: communication.outputs.connectionString
  }
  dependsOn: [
    keyVault
    communication
  ]
}

// --- Key Vault secret: Sheets service-account private key (admin/04) ---
// Only created when sheetsServiceAccountPrivateKey is provided at deploy
// time. PLACEHOLDER — Karan provisions the Google service account and
// supplies the PEM private key. The @secure() parameter is written
// straight into the vault; it never appears in outputs, logs, or app
// settings. The Function App reads it via a Key Vault reference
// (see function-app.bicep). The Function App's managed identity already
// holds Key Vault Secrets User on this vault (funcAppKvSecretsUser).
resource sheetsPrivateKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(sheetsServiceAccountPrivateKey)) {
  parent: kv
  name: sheetsPrivateKeySecretName
  properties: {
    value: sheetsServiceAccountPrivateKey
  }
  dependsOn: [
    keyVault
  ]
}

// --- Key Vault secret: unsubscribe token HMAC secret (email/03) ---
// Bootstrap: a deterministic uniqueString()-derived value, so it is stable
// across deployments without being committed to the repo. Three concatenated
// 13-char hashes give ~39 chars of entropy for the HMAC-SHA256 secret. The
// value is written straight into Key Vault; it never appears in outputs,
// logs, or app settings. The Function App reads it via a Key Vault
// reference (see function-app.bicep). Without it, the unsubscribe service
// fails closed with 503 on /api/v1/unsubscribe/{token} — CASL one-click
// unsubscribe links in every magic-link email depend on this.
resource unsubscribeTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: unsubscribeSecretName
  properties: {
    value: '${uniqueString(resourceGroup().id, 'feasly', 'unsubscribe-token-secret', 'v1-a')}${uniqueString(resourceGroup().id, 'feasly', 'unsubscribe-token-secret', 'v1-b')}${uniqueString(resourceGroup().id, 'feasly', 'unsubscribe-token-secret', 'v1-c')}'
  }
  dependsOn: [
    keyVault
  ]
}

// --- Role assignments ---
// Well-known role definition IDs (Microsoft.Authorization/roleDefinitions):
var kvSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7' // Key Vault Secrets Officer
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe' // Storage Blob Data Contributor
var storageBlobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b' // Storage Blob Data Owner (host secrets store)
var storageQueueDataContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88' // Storage Queue Data Contributor (trigger coordination)
var storageTableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3' // Storage Table Data Contributor (host state)
var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7' // Reader (admin/06 backup freshness ARM query)

// Deployer (CI OIDC identity or manual deployer) can write/read secrets in the vault.
// principalType is intentionally omitted so ARM infers it — manual deploys run
// as a User principal, CI OIDC deploys as a ServicePrincipal.
// The guid includes the deployer principal so manual (user) and CI (OIDC)
// deployers each get their own assignment instead of colliding on one name.
resource deployerSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, keyVaultName, kvSecretsOfficerRoleId, deployer().objectId)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsOfficerRoleId)
    principalId: deployer().objectId
  }
  dependsOn: [
    keyVault
  ]
}

// Function App system-assigned identity reads the Postgres password via Key Vault reference.
resource funcAppKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, keyVaultName, functionAppName, kvSecretsUserRoleId)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: functionApp.outputs.principalId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [
    keyVault
  ]
}

// Function App system-assigned identity accesses the Flex deployment container.
resource funcAppBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, storageName, functionAppName, storageBlobDataContributorRoleId)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: functionApp.outputs.principalId
    principalType: 'ServicePrincipal'
  }
  // NOTE: scoped at the resource group here (module outputs cannot be used in
  // roleAssignment name/scope, which must resolve at the start of deployment).
  // Tightening to the storage account scope is a future revision if needed.
}

// Function App system-assigned identity uses the storage account as the
// Functions host storage (AzureWebJobsStorage__accountName + managedidentity).
// The host needs blob (secrets/state), queue (trigger coordination), and table
// (host state) data-plane access. Follows the same RG-scope pattern as above.
resource funcAppHostStorageBlobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, storageName, functionAppName, storageBlobDataOwnerRoleId)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwnerRoleId)
    principalId: functionApp.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

resource funcAppHostStorageQueueContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, storageName, functionAppName, storageQueueDataContributorRoleId)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageQueueDataContributorRoleId)
    principalId: functionApp.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

resource funcAppHostStorageTableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, storageName, functionAppName, storageTableDataContributorRoleId)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRoleId)
    principalId: functionApp.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

// Function App system-assigned identity reads the Postgres server's backup
// config through ARM for the admin/06 `backup_missed` daily timer. Reader
// is the least-privilege built-in role that exposes
// Microsoft.DBforPostgreSQL/flexibleServers/read. Scoped at the resource
// group following the same pattern as the storage assignments above
// (module outputs cannot be used in roleAssignment scope).
resource funcAppPostgresReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, functionAppName, readerRoleId, 'postgres-backup-check')
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleId)
    principalId: functionApp.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

// --- Outputs ---
@description('Static Web App default hostname')
output swaHostname string = staticWebApp.outputs.hostname

@description('Function App default hostname')
output functionAppHostname string = functionApp.outputs.hostname

@description('Key Vault name')
output keyVaultName string = keyVault.outputs.name

@description('Postgres Flexible Server FQDN')
output postgresFqdn string = postgres.outputs.fqdn

// domainName is intentionally unused until the DNS module is wired (FND-014).
// Referencing it here keeps the param meaningful in what-if without failing lint.
@description('Custom domain (unused until DNS module is wired)')
output configuredDomain string = domainName
