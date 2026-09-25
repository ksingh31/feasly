// Feasly — Alert rules (BE8-001).
//
// - 5xx rate on the Function App: a log-based scheduled query rule against
//   the App Insights `AppRequests` table (Log Analytics). Flex Consumption
//   function apps do not emit the `Http5xx` platform metric, so a metric
//   alert cannot be used here.
//
// (Poison queue metric alert removed: QueueMessageCount is not available
// as a platform metric at the storage account level. To be re-added with
// a correct metric/namespace when needed.)
//
// Routes to the ops action group (email). Severity 2 = warning.
// Free-tier safe: alert rules are ~$0.10/mo each.

@description('Name prefix for alert resources')
param namePrefix string

@description('Azure region (alerts are global, but the location field is required)')
param location string = 'global'

@description('Resource ID of the Log Analytics workspace backing Application Insights')
param logAnalyticsWorkspaceId string

@description('Azure region of the Log Analytics workspace (scheduled query rules require a regional location, not global)')
param workspaceLocation string

@description('Ops notification email for the action group')
param opsAlertEmail string

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${namePrefix}-ops-ag'
  location: location
  properties: {
    groupShortName: 'feasly-ops'
    enabled: true
    emailReceivers: [
      {
        name: 'ops-email'
        emailAddress: opsAlertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

// 5xx alert: Flex Consumption function apps do NOT emit the `Http5xx`
// platform metric, so this is a log-based scheduled query rule against the
// App Insights `AppRequests` table (Log Analytics workspace table name).
// Fires when more than 5 requests return 5xx within a 5-minute window.
resource http5xxAlert 'Microsoft.Insights/scheduledQueryRules@2021-08-01' = {
  name: '${namePrefix}-http5xx'
  location: workspaceLocation
  properties: {
    description: 'Feasly API 5xx count above threshold (5 per 5 min)'
    severity: 2
    enabled: true
    scopes: [
      logAnalyticsWorkspaceId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          query: 'AppRequests | where TimeGenerated > ago(5m) | where ResultCode startswith "5" | summarize count()'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 5
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

@description('Resource ID of the ops action group')
output actionGroupId string = actionGroup.id
