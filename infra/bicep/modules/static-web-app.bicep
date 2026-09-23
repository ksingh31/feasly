// Feasly — Azure Static Web App (Free tier). No custom domain yet (domain TBD, FND-014).
@description('Static Web App name (globally unique)')
param name string

@description('Azure region — SWA is unavailable in Canada Central; closest is westus2')
param location string = 'westus2'

resource swa 'Microsoft.Web/staticSites@2024-04-01' = {
  name: name
  location: location
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    // Staging environments (PR previews) are configured in CD (FND-009), not IaC.
  }
}

@description('Default hostname, e.g. <name>.azurestaticapps.net')
output hostname string = swa.properties.defaultHostname

@description('Resource ID of the Static Web App')
output id string = swa.id
