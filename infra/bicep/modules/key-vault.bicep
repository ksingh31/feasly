// Feasly — Key Vault (Standard, RBAC authorization, soft delete).
// Secrets are written by main.bicep (postgres admin) and by CI runbooks;
// the Function App gets "Key Vault Secrets User" in main.bicep.
@description('Key Vault name (globally unique, 3-24 chars)')
param name string

@description('Azure region')
param location string = 'canadacentral'

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true // Azure rejects explicitly setting false; harmless for dev and protects against accidental vault loss
    publicNetworkAccess: 'Enabled'
  }
}

@description('Key Vault name')
output name string = kv.name

@description('Key Vault resource ID')
output id string = kv.id

@description('Key Vault URI, e.g. https://<name>.vault.azure.net/')
output vaultUri string = kv.properties.vaultUri
