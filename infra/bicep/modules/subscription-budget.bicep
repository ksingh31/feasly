// Subscription-scope cost budget `feasly-monthly-cap` with notification
// thresholds (#733 cost guardrail).
//
// The budget was created by hand (no thresholds in the repo). This module is
// the source of truth for its shape: 50 / 80 / 100 % of ACTUAL spend and
// 100 % of FORECAST spend, each to every address in `contactEmails` (the ops
// inbox plus a second contact). Amount: CA$10/month (owner confirmed
// 2026-11-15, #680). A budget only NOTIFIES — it never stops spend; the
// hard limits are the Function App instance cap and the Log Analytics daily
// cap (see docs/ops/cost.md). Budgets are free.
//
// Deployed from main.bicep with `scope: subscription()`, gated OFF by
// default (`manageBudget = false`) for the same reason as
// subscription-cost-reader.bicep (#637): the CD identity is RG-scoped and
// cannot write subscription-scope deployments or Microsoft.Consumption
// budgets, so turning it on fails what-if and the whole CD deploy. A
// subscription Owner applies it once (docs/ops/cost.md, "Budget").
targetScope = 'subscription'

@description('Budget name (keep: the nightly ops review reads it by name)')
param name string = 'feasly-monthly-cap'

@description('Monthly budget amount in the billing currency (CAD). Owner decision, #680.')
@minValue(1)
param amount int = 10

@description('First day of the first budget month, yyyy-MM-01 (must not be in the past when the budget is first created).')
param startDate string

@description('Notification recipients: the ops inbox plus a second contact.')
@minLength(1)
param contactEmails string[]

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: name
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
    }
    notifications: {
      actual50: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: contactEmails
      }
      actual80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: contactEmails
      }
      actual100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: contactEmails
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: contactEmails
      }
    }
  }
}

@description('Resource ID of the budget')
output budgetId string = budget.id
