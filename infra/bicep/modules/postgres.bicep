// Feasly — PostgreSQL Flexible Server 16, Burstable.
// dev/staging: Standard_B1ms, 7-day backup retention. prod: Standard_B2s, 30-day.
// Public network access enabled for dev (Managed Identity + firewall rules come later;
// per task spec: AllowAzureServices firewall rule 0.0.0.0-0.0.0.0).
@description('PostgreSQL Flexible Server name (globally unique)')
param name string

@description('Azure region')
param location string = 'canadacentral'

@description('Postgres admin login')
param adminLogin string = 'feaslyadmin'

@description('Postgres admin password (written to Key Vault by main.bicep)')
@secure()
param adminPassword string

@description('Flexible Server SKU (Burstable tier)')
@allowed([
  'Standard_B1ms'
  'Standard_B2s'
])
param skuName string = 'Standard_B1ms'

@description('Point-in-time-restore backup retention, days')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 7

@description('Storage size in GB')
@minValue(32)
param storageSizeGB int = 32

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: name
  location: location
  sku: {
    name: skuName
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    highAvailability: {
      mode: 'Disabled' // conscious M0 cost decision; revisit with revenue (FND-004)
    }
  }
}

resource allowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: server
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: 'feasly'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

@description('Fully qualified domain name of the Postgres server')
output fqdn string = server.properties.fullyQualifiedDomainName

@description('Postgres server name')
output serverName string = server.name

@description('Database name')
output databaseName string = database.name
