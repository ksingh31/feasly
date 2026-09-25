// Feasly — Metric alert rules (BE8-001).
//
// - 5xx rate on the Function App: fires when server errors spike.
// - Queue poison depth: fires when any message lands in a poison queue
//   (Azure Functions moves a queue message to `{queue}-poison` after 5
//   failed dequeue attempts).
//
// Both route to the ops action group (email). Severity 2 = warning.
// Free-tier safe: metric alerts on platform metrics incur no per-alert
// charge at this volume.

@description('Name prefix for alert resources')
param namePrefix string

@description('Azure region (alerts are global, but the location field is required)')
param location string = 'global'

@description('Resource ID of the Function App to monitor')
param functionAppId string

@description('Resource ID of the storage account holding the queues')
param storageAccountId string

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

resource http5xxAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${namePrefix}-http5xx'
  location: location
  properties: {
    description: 'Feasly API 5xx rate above threshold'
    severity: 2
    enabled: true
    scopes: [
      functionAppId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'Http5xxCount'
          metricName: 'Http5xx'
          metricNamespace: 'Microsoft.Web/sites'
          operator: 'GreaterThan'
          threshold: 5
          timeAggregation: 'Total'
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
          metricNamespace: 'Microsoft.Storage/storageAccounts/queueServices'
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
