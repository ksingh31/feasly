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

@description('Sender address for transactional email (must be an ACS-verified domain sender). Empty = app config default.')
param emailFromAddress string = ''

@description('CORS allowed origins for the Function App (ADM-10: the web app calls the API cross-origin). Never "*" when supportCredentials is true.')
param corsAllowedOrigins string[] = []

@description('Public base URL of the web app, used to build magic-link URLs in emails (ADM-10: must be the live SWA hostname, not the feasly.example config default).')
param appBaseUrl string = ''

@description('Google Sheet ID for the hourly leads sync (admin/04). Empty = sync disabled (fail-closed).')
param sheetsSheetId string = ''

@description('Google service-account email for the Sheets sync. Empty = sync disabled.')
param sheetsServiceAccountEmail string = ''

@description('Key Vault secret URI (versionless) for the Sheets service-account private key. Empty = not configured; the app fails closed on sync.')
param sheetsServiceAccountPrivateKeySecretUri string = ''

@description('Postgres backup freshness check (admin/06 backup_missed): enable the daily timer')
param backupCheckEnabled bool = false

@description('Azure subscription ID for the backup freshness ARM query')
param backupCheckSubscriptionId string = ''

@description('Resource group of the Postgres server for the backup freshness ARM query')
param backupCheckResourceGroup string = ''

@description('Postgres server name for the backup freshness ARM query')
param backupCheckServerName string = ''

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
            // admin/06 backup_missed: daily Postgres backup freshness timer.
            // Queries ARM with the app's system-assigned managed identity
            // (Reader role granted in main.bicep). Disabled by default; the
            // timer adapter fails closed when unconfigured.
            name: 'BACKUP_CHECK_ENABLED'
            value: backupCheckEnabled ? 'true' : 'false'
          }
          {
            name: 'BACKUP_CHECK_SUBSCRIPTION_ID'
            value: backupCheckSubscriptionId
          }
          {
            name: 'BACKUP_CHECK_RESOURCE_GROUP'
            value: backupCheckResourceGroup
          }
          {
            name: 'BACKUP_CHECK_SERVER_NAME'
            value: backupCheckServerName
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
            ],
        // Sender identity override (ADM-10): the provisioned Azure-managed
        // domain sender for dev. Empty elsewhere → the app config default.
        empty(emailFromAddress)
          ? []
          : [
              {
                name: 'EMAIL_FROM_ADDRESS'
                value: emailFromAddress
              }
            ],
        // Magic-link URLs in emails must open on the live site (ADM-10).
        // Empty → the app config default (feasly.example placeholder).
        empty(appBaseUrl)
          ? []
          : [
              {
                name: 'APP_BASE_URL'
                value: appBaseUrl
              }
            ],
        // admin/04 — hourly Google Sheets sync. Sheet ID + service-account
        // email are plain config (not secrets); the private key is a Key
        // Vault reference. All empty until Karan provisions the service
        // account (placeholders) — the worker fails closed when unset.
        [
          {
            name: 'SHEETS_SHEET_ID'
            value: sheetsSheetId
          }
          {
            name: 'SHEETS_SERVICE_ACCOUNT_EMAIL'
            value: sheetsServiceAccountEmail
          }
        ],
        empty(sheetsServiceAccountPrivateKeySecretUri)
          ? []
          : [
              {
                // Key Vault reference — the PEM private key never lands in app settings.
                name: 'SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY'
                value: '@Microsoft.KeyVault(SecretUri=${sheetsServiceAccountPrivateKeySecretUri})'
              }
            ]
      )
      // CORS (ADM-10): the SWA calls this API cross-origin (Free SKU has no
      // linked backend). supportCredentials=true so the session cookie flows;
      // allowedOrigins is an explicit allowlist — never '*'.
      cors: {
        allowedOrigins: corsAllowedOrigins
        supportCredentials: true
      }
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
