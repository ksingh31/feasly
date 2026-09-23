// Feasly — Function App on Flex Consumption (FC1) plan, Node 20.
// Flex Consumption requires functionAppConfig.deployment.storage pointing at a blob
// container; auth is via the app's system-assigned managed identity (the "Storage Blob
// Data Contributor" role on the storage account is granted in main.bicep).
@description('Function App name (globally unique, *.azurewebsites.net)')
param name string

@description('Flex Consumption plan name')
param planName string

@description('Azure region')
param location string = 'canadacentral'

@description('Blob URL of the deployment container, e.g. https://<sa>.blob.core.windows.net/deployment')
param deploymentStorageContainerUrl string

@description('Application Insights connection string (non-secret)')
param appInsightsConnectionString string

@description('Postgres server FQDN')
param postgresHost string

@description('Postgres database name')
param postgresDatabase string

@description('Postgres admin login')
param postgresUser string

@description('Key Vault secret URI (versionless) for the Postgres admin password, e.g. https://<kv>.vault.azure.net/secrets/<name>')
param postgresPasswordSecretUri string

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true // Linux
  }
}

resource app 'Microsoft.Web/sites@2024-04-01' = {
  name: name
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      appSettings: [
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        {
          name: 'POSTGRES_HOST'
          value: postgresHost
        }
        {
          name: 'POSTGRES_DB'
          value: postgresDatabase
        }
        {
          name: 'POSTGRES_USER'
          value: postgresUser
        }
        {
          // Key Vault reference — the password value never lands in app settings.
          name: 'POSTGRES_PASSWORD'
          value: '@Microsoft.KeyVault(SecretUri=${postgresPasswordSecretUri})'
        }
        // NOTE: no FUNCTIONS_WORKER_RUNTIME / WEBSITE_NODE_DEFAULT_VERSION here —
        // Flex Consumption rejects them; the runtime is declared in
        // functionAppConfig.runtime below.
      ]
    }
    // functionAppConfig MUST be a direct child of properties (sibling of
    // siteConfig) — Flex Consumption requires it on site create. The Bicep
    // type definition for Microsoft.Web/sites@2024-04-01 has not caught up,
    // so the warning is suppressed deliberately.
    #disable-next-line BCP037
    functionAppConfig: {
      runtime: {
        name: 'node'
        version: '20'
      }
      deployment: {
        storage: {
          type: 'blobContainer'
          value: deploymentStorageContainerUrl
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 100
        instanceMemoryMB: 2048
      }
    }
  }
}

@description('Function App default hostname, e.g. <name>.azurewebsites.net')
output hostname string = app.properties.defaultHostName

@description('Function App resource ID')
output id string = app.id

@description('Function App system-assigned managed identity principal ID')
output principalId string = app.identity.principalId
