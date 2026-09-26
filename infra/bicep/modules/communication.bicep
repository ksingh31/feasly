// Feasly — Azure Communication Services email (story ADM-10).
//
// Provisions the Email Communication Service with an Azure-managed domain
// (no custom-domain DNS verification needed) and links it to a
// Communication Service resource. The ACS connection string is derived via
// listKeys() and written straight into Key Vault by main.bicep — it never
// appears in outputs, logs, or app settings.
//
// Cost (verified 2026-09-26): resources are FREE to provision. Billing is
// pure consumption — $0.00025/email + $0.00012/MB transferred, no paid tier,
// no committed spend, no free allowance. Overnight verification (a handful
// of admin magic links) costs sub-cent — effectively $0. Azure-managed
// domain rate limit: 5/min, 10/hour (fixed; fine for admin use).
@description('Environment short name (dev/stg/prod)')
param envShort string

@description('6-char hash suffix for globally-unique resource names')
param token string

var emailServiceName = 'feasly-${envShort}-email-${token}'
var acsName = 'feasly-${envShort}-acs-${token}'

resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = {
  name: emailServiceName
  location: 'global'
  properties: {
    dataLocation: 'UnitedStates'
  }
}

// The Azure-managed domain provisions as <guid>.azurecomm.net — no DNS
// verification needed. Resource name must literally be 'AzureManagedDomain'.
//
// PLACEHOLDER (ADM-10): the Azure-managed domain is a temporary sender for
// overnight verification only. Swap for Karan's custom domain
// (domainManagement: 'CustomerManaged' + DNS verification) when he provides
// one — the sender address below changes with it.
resource azureManagedDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = {
  parent: emailService
  name: 'AzureManagedDomain'
  location: 'global'
  properties: {
    domainManagement: 'AzureManaged'
  }
}

resource acs 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: acsName
  location: 'global'
  properties: {
    dataLocation: 'UnitedStates'
    linkedDomains: [
      azureManagedDomain.id
    ]
  }
}

@description('Primary ACS connection string (secure — written straight to Key Vault, never logged)')
@secure()
output connectionString string = acs.listKeys().primaryConnectionString

@description('Provisioned Azure-managed sender domain, e.g. <guid>.azurecomm.net')
output senderDomain string = azureManagedDomain.properties.mailFromSenderDomain

@description('Full sender address for transactional email (DoNotReply@<guid>.azurecomm.net). PLACEHOLDER (ADM-10): Azure-managed sender for overnight verification — swap for Karan\'s custom-domain sender when he provides one.')
output senderAddress string = 'DoNotReply@${azureManagedDomain.properties.mailFromSenderDomain}'
