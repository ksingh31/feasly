// Feasly — Log Analytics workspace + workspace-based Application Insights.
@description('Application Insights component name')
param name string

@description('Log Analytics workspace name')
param workspaceName string

@description('Azure region')
param location string = 'canadacentral'

@description('Log Analytics daily ingestion cap in GB (#733). Owner decision 2026-11-15: 0.1 GB/day. When reached, ingestion pauses until the next UTC day (the app keeps serving — only telemetry stops) and the `<prefix>-law-daily-cap` alert fires. Fractional values are allowed (minimum 0.023).')
param dailyQuotaGb string = '0.1'

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    // #733: bounded log ingestion (the workspace defaulted to -1 = no cap).
    // json() because Bicep has no float literal; the ARM property is a double.
    workspaceCapping: {
      dailyQuotaGb: json(dailyQuotaGb)
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource ai 'Microsoft.Insights/components@2020-02-02' = {
  name: name
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: law.id
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

@description('Application Insights connection string (non-secret)')
output connectionString string = ai.properties.ConnectionString

@description('Resource ID of the Application Insights component')
output id string = ai.id

@description('Resource ID of the Log Analytics workspace')
output workspaceId string = law.id
