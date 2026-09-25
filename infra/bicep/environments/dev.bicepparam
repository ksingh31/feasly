// Feasly dev environment parameters.
// Postgres admin password is NEVER stored here. It resolves from the
// FEASLY_POSTGRES_ADMIN_PASSWORD environment variable (empty by default) or,
// preferred, is passed explicitly at deploy time:
//   --parameters postgresAdminPassword='<from-Key-Vault-or-generated>'
// An explicit --parameters value always overrides this file's value.
//
// ACS email: dev sends real email via Azure Communication Services so admin
// magic links land in Gmail (QA needs this). The connection string is NEVER
// stored here — it resolves from FEASLY_ACS_CONNECTION_STRING or is passed
// explicitly at deploy time:
//   --parameters acsConnectionString='<from-Key-Vault>'
using '../main.bicep'

param environment = 'dev'
param location = 'canadacentral'
param postgresSkuName = 'Standard_B1ms'
param postgresBackupRetentionDays = 7
param domainName = ''
param postgresAdminPassword = readEnvironmentVariable('FEASLY_POSTGRES_ADMIN_PASSWORD', '')
param emailProvider = 'acs'
param acsConnectionString = readEnvironmentVariable('FEASLY_ACS_CONNECTION_STRING', '')
