// Feasly prod environment parameters.
// prod: Postgres B2s + 30-day backup retention (parameter change, not a migration).
// DO-NOT-RUN any prod deployment without Karan's explicit approval (per story FND-009).
// Postgres admin password is NEVER stored here. It resolves from the
// FEASLY_POSTGRES_ADMIN_PASSWORD environment variable (empty by default) or,
// preferred, is passed explicitly at deploy time:
//   --parameters postgresAdminPassword='<from-Key-Vault-or-generated>'
// An explicit --parameters value always overrides this file's value.
using '../main.bicep'

param environment = 'prod'
param location = 'canadacentral'
param postgresSkuName = 'Standard_B2s'
param postgresBackupRetentionDays = 30
param domainName = ''
param postgresAdminPassword = readEnvironmentVariable('FEASLY_POSTGRES_ADMIN_PASSWORD', '')
