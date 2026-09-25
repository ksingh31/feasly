// Feasly staging environment parameters.
// Postgres admin password is NEVER stored here. It resolves from the
// FEASLY_POSTGRES_ADMIN_PASSWORD environment variable (empty by default) or,
// preferred, is passed explicitly at deploy time:
//   --parameters postgresAdminPassword='<from-Key-Vault-or-generated>'
// An explicit --parameters value always overrides this file's value.
//
// Email: staging keeps the 'log' provider until the ACS sender domain is
// verified for staging. Flip emailProvider to 'acs' and provide the
// connection string (via FEASLY_ACS_CONNECTION_STRING or explicit
// --parameters acsConnectionString) when ready.
using '../main.bicep'

param environment = 'staging'
param location = 'canadacentral'
param postgresSkuName = 'Standard_B1ms'
param postgresBackupRetentionDays = 7
param domainName = ''
param postgresAdminPassword = readEnvironmentVariable('FEASLY_POSTGRES_ADMIN_PASSWORD', '')
param emailProvider = 'log'
param acsConnectionString = readEnvironmentVariable('FEASLY_ACS_CONNECTION_STRING', '')
