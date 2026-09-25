// Feasly — Function App on Flex Consumption (FC1) plan, Node 22.
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

@description('Storage account name for the Functions host storage (AzureWebJobsStorage, identity-based)')
param storageAccountName string

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

@description('Email provider: log (dev default), postmark, or acs')
@allowed([
  'log'
  'postmark'
  'acs'
])
param emailProvider string = 'log'

@description('Key Vault secret URI (versionless) for the ACS email connection string. Empty = not configured; the app fails closed on send.')
param acsConnectionStringSecretUri string = ''

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
      // EMAIL_ACS_CONNECTION_STRING is appended only when a Key Vault secret
      // URI is provided; without it the app fails closed on send (clear error,
      // no silent drops). The secret value never lands in app settings.
      appSettings: concat(
        [
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
          {
            name: 'EMAIL_PROVIDER'
            value: emailProvider
          }
          {
            // Cap the Node.js worker heap at 1536MB: the default
            // --max-old-space-size=6144 (6GB) OOM-crashes on the 2048MB Flex
            // Consumption instance. 1536MB leaves room for Functions host overhead.
            name: 'languageWorkers__node__arguments'
            value: '--max-old-space-size=1536'
          }
          {
            // Functions host storage (required): identity-based connection to the
            // storage account. The host uses blob/queue/table for trigger
            // coordination (incl. the community-stats timer). System-assigned
            // managed identity, so no __clientId is needed. Flex Consumption
            // does not accept a connection-string AzureWebJobsStorage.
            name: 'AzureWebJobsStorage__accountName'
            value: storageAccountName
          }
          {
            name: 'AzureWebJobsStorage__credential'
            value: 'managedidentity'
          }
          // NOTE: no FUNCTIONS_WORKER_RUNTIME / WEBSITE_NODE_DEFAULT_VERSION here —
          // Flex Consumption rejects them; the runtime is declared in
          // functionAppConfig.runtime below.
        ],
        empty(acsConnectionStringSecretUri)
          ? []
          : [
              {
                // Key Vault reference — the connection string value never lands in app settings.
                name: 'EMAIL_ACS_CONNECTION_STRING'
                value: '@Microsoft.KeyVault(SecretUri=${acsConnectionStringSecretUri})'
              }
            ]
      )
    }
    // functionAppConfig MUST be a direct child of properties (sibling of
    // siteConfig) — Flex Consumption requires it on site create. The Bicep
    // type definition for Microsoft.Web/sites@2024-04-01 has not caught up,
    // so the warning is suppressed deliberately.
    #disable-next-line BCP037
    functionAppConfig: {
      runtime: {
        name: 'node'
        version: '22'
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
