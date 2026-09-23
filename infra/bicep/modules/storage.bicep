// Feasly — Blob Storage account.
// - `tenant-assets`: private container (tenant logos, dispute evidence, report assets)
// - `deployment`: container backing the Flex Consumption Function App deployment storage
// Lifecycle rule: dispute-evidence blobs archived after 90 days, deleted after 7 years (2555d).
@description('Storage account name: lowercase alphanumeric, globally unique, 3-24 chars')
param name string

@description('Azure region')
param location string = 'canadacentral'

resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: sa
  name: 'default'
  properties: {}
}

resource tenantAssets 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: 'tenant-assets'
  properties: {
    publicAccess: 'None'
  }
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: 'deployment'
  properties: {
    publicAccess: 'None'
  }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: sa
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          enabled: true
          name: 'dispute-evidence-7yr-retention'
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'tenant-assets/dispute-evidence/'
              ]
            }
            actions: {
              baseBlob: {
                // Archive after 90 days (dev documentation purpose); delete only after
                // 7 years (2555 days) to satisfy the >=7-year retention requirement.
                tierToArchive: {
                  daysAfterModificationGreaterThan: 90
                }
                delete: {
                  daysAfterModificationGreaterThan: 2555
                }
              }
            }
          }
        }
      ]
    }
  }
}

@description('Storage account name')
output name string = sa.name

@description('Storage account resource ID')
output id string = sa.id

@description('Blob URL of the Flex deployment container')
output deploymentContainerUrl string = 'https://${sa.name}.blob.${environment().suffixes.storage}/deployment'
