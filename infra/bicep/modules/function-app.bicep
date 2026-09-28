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

@description('CORS allowed origins for the Function App (ADM-10: the web app calls the API cross-origin). Fed to the in-app CORS middleware via CORS_ORIGINS — the single CORS source; platform-level CORS stays OFF so responses never carry duplicate Access-Control-Allow-Origin headers. Never "*".')
param corsAllowedOrigins string[] = []

@description('Public base URL of the web app, used to build magic-link URLs in emails (ADM-10: must be the live SWA hostname, not the feasly.example config default).')
param appBaseUrl string = ''

@description('Google Sheet ID for the hourly leads sync (admin/04). Empty = sync disabled (fail-closed).')
param sheetsSheetId string = ''

@description('Google service-account email for the Sheets sync. Empty = sync disabled.')
param sheetsServiceAccountEmail string = ''

@description('Key Vault secret URI (versionless) for the Sheets service-account private key. Empty = not configured; the app fails closed on sync.')
param sheetsServiceAccountPrivateKeySecretUri string = ''

@description('Key Vault secret URI (versionless) for the unsubscribe token HMAC secret (email/03). Empty = not configured; the app fails closed (503) on /api/v1/unsubscribe/{token}.')
param unsubscribeTokenSecretUri string = ''

@description('AI summary (narrative worker) provider: log = dev/test console transport (refuses production); openai-compatible = any OpenAI-protocol chat-completions endpoint (Gemini).')
param narrativeProvider string = 'log'

@description('Key Vault secret URI (versionless) for the narrative LLM API key (Gemini). Empty = not configured; the provider fails closed naming the env var. Karan provisions the key in Key Vault himself — Bicep only references it, never writes it.')
param narrativeApiKeySecretUri string = ''

@description('Base URL of the OpenAI-compatible endpoint for the narrative provider. Empty = the app config default.')
param narrativeEndpoint string = ''

@description('Model slug for the narrative provider (e.g. gemini-3.8-flash). Empty = the app config default.')
param narrativeModels string = ''

@description('Base URL of the fallback OpenAI-compatible narrative endpoint (Groq). Empty = the app config default.')
param narrativeFallbackEndpoint string = ''

@description('Key Vault secret URI (versionless) for the fallback narrative LLM API key (Groq). Empty = not configured; the Groq step is skipped gracefully. Karan provisions the key in Key Vault himself — Bicep only references it, never writes it.')
param narrativeFallbackApiKeySecretUri string = ''

@description('Model slug(s) for the fallback narrative provider (e.g. openai/gpt-oss-120b). Empty = the app config default.')
param narrativeFallbackModels string = ''

@description('Microsoft Entra External ID: tenant subdomain — the ciamlogin.com host prefix (e.g. feaslyext). Empty = the admin sign-in callback fails closed (503).')
param entraTenantSubdomain string = ''

@description('Microsoft Entra External ID: tenant (directory) ID. Empty = the admin sign-in callback fails closed (503).')
param entraTenantId string = ''

@description('Microsoft Entra External ID: application (client) ID of the feasly-web SPA app registration. Empty = the admin sign-in callback fails closed (503).')
param entraClientId string = ''

@description('Microsoft Entra External ID: user flow (policy) name, e.g. feasly-signup-signin. Empty = the admin sign-in callback fails closed (503).')
param entraUserFlow string = ''

@description('Microsoft Entra External ID: issuer domain for local-account provisioning (e.g. feaslyext.onmicrosoft.com). Empty = Graph provisioning fails closed.')
param entraIssuerDomain string = ''

@description('Microsoft Entra External ID: Graph client (application) ID used for user provisioning. Empty = Graph provisioning fails closed.')
param entraGraphClientId string = ''

@description('Key Vault secret URI (versionless) for the Graph client secret used for user provisioning. Empty = not configured; provisioning fails closed. The raw secret is provisioned in Key Vault outside Bicep — Bicep only references it, never writes it.')
param entraGraphClientSecretUri string = ''

@description('Key Vault secret URI (versionless) for the feasly-web client secret used in the admin sign-in token exchange (confidential client). Empty = not configured; the Entra callback fails closed. The raw secret is provisioned in Key Vault outside Bicep — Bicep only references it, never writes it.')
param entraClientSecretUri string = ''

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
              // Preference-center links in emails must open on the live site
              // (same ADM-10 rule as magic links): derive from appBaseUrl so
              // emailed unsubscribe/preference footers never point at the
              // feasly.example config default.
              {
                name: 'UNSUBSCRIBE_URL_BASE'
                value: '${appBaseUrl}/unsubscribe'
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
            ],
        // email/03 — one-click unsubscribe token HMAC secret. Without it the
        // unsubscribe service fails closed with 503 (CASL). Empty = the
        // app setting is omitted entirely so the fail-closed behavior is
        // obvious rather than an empty string slipping through.
        empty(unsubscribeTokenSecretUri)
          ? []
          : [
              {
                // Key Vault reference — the HMAC secret value never lands in app settings.
                name: 'UNSUBSCRIBE_TOKEN_SECRET'
                value: '@Microsoft.KeyVault(SecretUri=${unsubscribeTokenSecretUri})'
              }
            ],
        // AI summary (narrative worker): the real LLM provider. Values are
        // set per environment in main.bicep; empty = the app setting is
        // omitted and the app falls back to its config default (log
        // provider, dev/test console transport). The API key is a Key Vault
        // reference — the value never lands in app settings. Karan
        // provisions the key in Key Vault himself; Bicep only references it.
        empty(narrativeProvider)
          ? []
          : [
              {
                name: 'NARRATIVE_PROVIDER'
                value: narrativeProvider
              }
            ],
        empty(narrativeApiKeySecretUri)
          ? []
          : [
              {
                name: 'NARRATIVE_API_KEY'
                value: '@Microsoft.KeyVault(SecretUri=${narrativeApiKeySecretUri})'
              }
            ],
        empty(narrativeEndpoint)
          ? []
          : [
              {
                name: 'NARRATIVE_ENDPOINT'
                value: narrativeEndpoint
              }
            ],
        empty(narrativeModels)
          ? []
          : [
              {
                name: 'NARRATIVE_MODELS'
                value: narrativeModels
              }
            ],
        empty(narrativeFallbackEndpoint)
          ? []
          : [
              {
                name: 'NARRATIVE_FALLBACK_ENDPOINT'
                value: narrativeFallbackEndpoint
              }
            ],
        empty(narrativeFallbackApiKeySecretUri)
          ? []
          : [
              {
                name: 'NARRATIVE_FALLBACK_API_KEY'
                value: '@Microsoft.KeyVault(SecretUri=${narrativeFallbackApiKeySecretUri})'
              }
            ],
        empty(narrativeFallbackModels)
          ? []
          : [
              {
                name: 'NARRATIVE_FALLBACK_MODELS'
                value: narrativeFallbackModels
              }
            ],
        // Microsoft Entra External ID sign-in (admin/builder). Values are
        // set per environment in main.bicep; empty = the app setting is
        // omitted and the backend fails closed (503) naming the missing
        // variable. The Graph client secret is a Key Vault reference — the
        // value never lands in app settings.
        empty(entraTenantSubdomain)
          ? []
          : [
              {
                name: 'ENTRA_TENANT_SUBDOMAIN'
                value: entraTenantSubdomain
              }
            ],
        empty(entraTenantId)
          ? []
          : [
              {
                name: 'ENTRA_TENANT_ID'
                value: entraTenantId
              }
            ],
        empty(entraClientId)
          ? []
          : [
              {
                name: 'ENTRA_CLIENT_ID'
                value: entraClientId
              }
            ],
        empty(entraUserFlow)
          ? []
          : [
              {
                name: 'ENTRA_USER_FLOW'
                value: entraUserFlow
              }
            ],
        empty(entraIssuerDomain)
          ? []
          : [
              {
                name: 'ENTRA_ISSUER_DOMAIN'
                value: entraIssuerDomain
              }
            ],
        empty(entraGraphClientId)
          ? []
          : [
              {
                name: 'ENTRA_GRAPH_CLIENT_ID'
                value: entraGraphClientId
              }
            ],
        empty(entraGraphClientSecretUri)
          ? []
          : [
              {
                // Key Vault reference — the client secret value never lands in app settings.
                name: 'ENTRA_GRAPH_CLIENT_SECRET'
                value: '@Microsoft.KeyVault(SecretUri=${entraGraphClientSecretUri})'
              }
            ],
        empty(entraClientSecretUri)
          ? []
          : [
              {
                // Key Vault reference — the client secret value never lands in app settings.
                name: 'ENTRA_CLIENT_SECRET'
                value: '@Microsoft.KeyVault(SecretUri=${entraClientSecretUri})'
              }
            ],
        // CORS allowlist for the in-app middleware (ADM-10): the SWA calls
        // this API cross-origin (Free SKU has no linked backend). The
        // resolveCorsHeaders middleware echoes allowlisted origins with
        // Access-Control-Allow-Credentials: true so the SameSite=None session
        // cookies flow. Explicit allowlist — never '*'. Empty = the
        // middleware emits no CORS headers (fail-closed).
        [
          {
            name: 'CORS_ORIGINS'
            value: join(corsAllowedOrigins, ',')
          }
        ]
      )
      // In-app CORS is the single CORS source: platform-level siteConfig.cors
      // is deliberately NOT set — the two layers would each emit
      // Access-Control-Allow-Origin and browsers would reject credentialed
      // requests on the duplicate header. Never re-add cors here.
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
