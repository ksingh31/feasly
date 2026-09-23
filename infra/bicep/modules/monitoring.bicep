// Feasly — Log Analytics workspace + workspace-based Application Insights.
@description('Application Insights component name')
param name string

@description('Log Analytics workspace name')
param workspaceName string

@description('Azure region')
param location string = 'canadacentral'

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
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
