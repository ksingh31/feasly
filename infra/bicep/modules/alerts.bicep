// Feasly — Alert rules (BE8-001).
//
// - 5xx rate on the Function App: a log-based scheduled query rule against
//   the App Insights `AppRequests` table (Log Analytics). Flex Consumption
//   function apps do not emit the `Http5xx` platform metric, so a metric
//   alert cannot be used here.
// - Timer schedule-monitor health: a log-based scheduled query rule against
//   `AppExceptions` for the Functions host's StorageScheduleMonitor failing
//   to access host storage ("Could not create BlobContainer"). When the
//   Function App's managed identity loses data-plane access to the host
//   storage account, EVERY timer trigger (nudge, sheets sync, purges,
//   …) silently stops firing — this alert pages ops before leads rot.
// - Email send-failure monitor: a log-based scheduled query rule against
//   `AppTraces` for the ACS provider's structured `email.send-failed` event
//   (consumer magic-link emails stopped arriving with the UI claiming
//   success, Sep 2026). The event is emitted at every provider throw site;
//   the nudge timer's per-lead try/catch swallows send failures, so this is
//   the only place timer-path failures surface.
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

// Timer schedule-monitor health (nudge-timer incident, Sep 2026): the
// Functions host persists timer schedules in the `azure-webjobs-hosts`
// blob container on the host storage account (AzureWebJobsStorage). When
// the app's managed identity cannot create that container — e.g. the
// Storage Blob Data Owner/Contributor role assignment is missing or not
// effective — the host throws
// `InvalidOperationException("Could not create BlobContainer")` at
// `StorageScheduleMonitor.get_ContainerClient` and NO timer trigger on the
// app fires (nudge, sheets sync, purges, …), silently. The RBAC itself is
// declared in main.bicep (#124/#131); this alert catches the case where
// the assignment is declared but not effective in Azure.
// Fires on 3+ such exceptions in 15 minutes (the incident ran ~14/hour).
resource timerScheduleMonitorAlert 'Microsoft.Insights/scheduledQueryRules@2021-08-01' = {
  name: '${namePrefix}-timer-schedule-monitor'
  location: workspaceLocation
  properties: {
    description: 'Functions host StorageScheduleMonitor cannot access host storage — timer triggers are not firing'
    severity: 2
    enabled: true
    scopes: [
      logAnalyticsWorkspaceId
    ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          query: 'AppExceptions | where TimeGenerated > ago(15m) | where ProblemId contains "StorageScheduleMonitor" or OuterMessage contains "Could not create BlobContainer" | summarize count()'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 2
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

// Email send-failure monitor (magic-link email outage, Sep 2026): consumer
// magic-link emails stopped arriving (~05:29 UTC) while the UI claimed
// success. The send path threw, but nothing watched it — the nudge timer
// even swallows per-lead send failures, so timer-path failures surface
// nowhere else. The ACS provider now emits a structured `email.send-failed`
// JSON line (console → Application Insights `AppTraces`) at every throw
// site, and this rule fires on 3+ such events in 15 minutes (the outage
// ran at a comparable rate; single transient failures don't page).
resource emailSendFailureAlert 'Microsoft.Insights/scheduledQueryRules@2021-08-01' = {
  name: '${namePrefix}-email-send-failures'
  location: workspaceLocation
  properties: {
    description: 'Consumer email sends failing — ACS provider threw (magic links, nudges, ops mail)'
    severity: 2
    enabled: true
    scopes: [
      logAnalyticsWorkspaceId
    ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          query: 'AppTraces | where TimeGenerated > ago(15m) | where Message contains "email.send-failed" | summarize count()'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 2
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
