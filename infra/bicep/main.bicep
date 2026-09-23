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

@description('Custom domain (empty until FND-014 resolves the domain purchase)')
param domainName string = ''

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
@allowed([
  'User'
  'ServicePrincipal'
])
param deployerPrincipalType string = 'ServicePrincipal'

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

// --- Function App (Flex Consumption) ---
module functionApp 'modules/function-app.bicep' = {
  name: 'function-app'
  params: {
    name: functionAppName
    planName: functionPlanName
    location: location
    deploymentStorageContainerUrl: storage.outputs.deploymentContainerUrl
    appInsightsConnectionString: monitoring.outputs.connectionString
    postgresHost: postgres.outputs.fqdn
    postgresDatabase: postgres.outputs.databaseName
    postgresUser: postgresAdminLogin
    postgresPasswordSecretUri: postgresPasswordSecretUri
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

// --- Role assignments ---
// Well-known role definition IDs (Microsoft.Authorization/roleDefinitions):
var kvSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7' // Key Vault Secrets Officer
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe' // Storage Blob Data Contributor

// Deployer (CI OIDC identity or manual deployer) can write/read secrets in the vault.
resource deployerSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, keyVaultName, kvSecretsOfficerRoleId)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsOfficerRoleId)
    principalId: deployer().objectId
    principalType: deployerPrincipalType
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
