// Subscription-scope, read-only cost access for the CI/ops identity (#574).
//
// The nightly ops review (`.github/workflows/agent-ops.yml`) logs in as the
// same OIDC identity that deploys this template and runs
// `az consumption budget list` to check spend against the subscription-scoped
// `feasly-monthly-cap` budget. Resource-group Contributor cannot read
// subscription budgets (RBACAccessDenied), so this grants the built-in
// **Cost Management Reader** role at subscription scope. It is read-only
// (Microsoft.Consumption/*/read, Microsoft.CostManagement/*/read, ...) and
// costs nothing. One assignment per principal per subscription: every
// environment deployed by the same identity resolves to the same name.
//
// Deployed from main.bicep (resource-group scope) with `scope: subscription()`.
// The deploying identity must hold Microsoft.Authorization/roleAssignments/write
// at subscription scope (Owner or User Access Administrator); ARM role
// assignments are idempotent, so re-deploys are no-ops.
targetScope = 'subscription'

@description('Object ID of the principal that gets Cost Management Reader on the subscription')
param principalId string

var costManagementReaderRoleId = '72fafb9e-0641-4937-9268-a91bfd8191a3' // Cost Management Reader

// principalType intentionally omitted (same as deployerSecretsOfficer in
// main.bicep): CI deploys as a ServicePrincipal, manual deploys as a User.
resource costReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, costManagementReaderRoleId, principalId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', costManagementReaderRoleId)
    principalId: principalId
    description: 'Feasly CI/ops identity: read feasly-monthly-cap budget spend (#574)'
  }
}

@description('Resource ID of the Cost Management Reader role assignment')
output roleAssignmentId string = costReader.id
