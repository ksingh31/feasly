// Feasly — Azure DNS zone + Static Web App custom-domain verification records.
// AUTHOR ONLY (2026-09-23): no domain owned yet (FND-014). NOT wired into main.bicep.
// Once the domain is decided: set `domainName` and the SWA validation token, then wire
// this module into main.bicep (or a DNS-only deployment) and add the custom domain on
// the Static Web App.
@description('Domain name, e.g. feasly.com. Leave empty until the domain is owned.')
param domainName string = ''

@description('SWA domain-validation token from the portal (goes into the _dnsauth TXT record)')
@secure()
param swaValidationToken string = ''

// Once the domain is decided: create the zone below, add the _dnsauth TXT record with
// the validation token from the SWA portal blade, then point the domain at the SWA via
// a CNAME (e.g. www -> <swa-name>.azurestaticapps.net) or ANAME/ALIAS at the apex,
// and add the custom domain in the Static Web App (managed TLS is free).

resource zone 'Microsoft.Network/dnsZones@2018-05-01' = if (!empty(domainName)) {
  name: domainName
  location: 'global'
  properties: {
    zoneType: 'Public'
  }
}

// SWA custom-domain ownership proof: TXT record at _dnsauth.<domain> with the
// token shown in the Azure portal when adding the custom domain.
resource dnsauth 'Microsoft.Network/dnsZones/TXT@2018-05-01' = if (!empty(domainName) && !empty(swaValidationToken)) {
  parent: zone
  name: '_dnsauth'
  properties: {
    TTL: 3600
    TXTRecords: [
      {
        value: [
          swaValidationToken
        ]
      }
    ]
  }
}

@description('Name servers assigned to the zone (point the registrar NS records here)')
output nameServers array = zone.?properties.?nameServers ?? []
