// Feasly — Alert rules (BE8-001).
//
// - 5xx rate on the Function App: a log-based scheduled query rule against
//   the App Insights `requests` table. (Flex Consumption function apps do not
//   emit the `Http5xx` platform metric under Microsoft.Web/sites, so a metric
//   alert cannot be used here.)
// - Queue poison depth: a metric alert on `QueueMessageCount` (storage
//   account level) — fires when any message lands in a poison queue
//   (Azure Functions moves a queue message to `{queue}-poison` after 5
//   failed dequeue attempts).
//
// Both route to the ops action group (email). Severity 2 = warning.
// Free-tier safe: no per-alert charge at this volume (alert rules are
// ~$0.10/mo each; 2 rules total).

@description('Name prefix for alert resources')
param namePrefix string

@description('Azure region (alerts are global, but the location field is required)')
param location string = 'global'

@description('Resource ID of the storage account holding the queues')
param storageAccountId string

@description('Resource ID of the Log Analytics workspace backing Application Insights')
param logAnalyticsWorkspaceId string

@description('Azure region of the Log Analytics workspace (scheduled query rules require a regional location, not global)')
param workspaceLocation string

@description('Ops notification email for the action group')
param opsAlertEmail string

@description('Poison queue names to watch (queue names + "-poison" suffix)')
param poisonQueueNames array = [
  'email-queue-poison'
  'pdf-queue-poison'
  'sheets-queue-poison'
]

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
// App Insights `requests` table instead. Fires when more than 5 requests
// return 5xx within a 5-minute window.
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
          query: 'requests | where timestamp > ago(5m) | where resultCode startswith "5" | summarize count()'
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

resource poisonQueueAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${namePrefix}-poison-queue'
  location: location
  properties: {
    description: 'Feasly poison queue depth above zero'
    severity: 2
    enabled: true
    scopes: [
      storageAccountId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'PoisonQueueDepth'
          metricName: 'QueueMessageCount'
          metricNamespace: 'Microsoft.Storage/storageAccounts'
          dimensions: [
            {
              name: 'QueueName'
              operator: 'Include'
              values: poisonQueueNames
            }
          ]
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Maximum'
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
  }
}

@description('Resource ID of the ops action group')
output actionGroupId string = actionGroup.id
