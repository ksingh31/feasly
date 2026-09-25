#!/usr/bin/env bash
# check-postgres-backup.sh — assert PITR-capable backup config on the Feasly Postgres.
#
# Read-only: issues `az postgres flexible-server show/list` and nothing else.
# Used by CI (.github/workflows/ci.yml -> backup-config job) and locally:
#   PG_RESOURCE_GROUP=rg-feasly-dev bash infra/health/check-postgres-backup.sh
#
# Env overrides (all optional):
#   PG_RESOURCE_GROUP       default: rg-feasly-dev
#   PG_SERVER_NAME          default: discover first server starting with feasly-dev-pg
#   PG_MIN_RETENTION_DAYS   default: 7
#
# Fails (exit 1) when: retention < minimum, or the earliest restore point is
# older than 48h (meaning automated backups are not actually running).
set -euo pipefail

RG="${PG_RESOURCE_GROUP:-rg-feasly-dev}"
MIN_RETENTION_DAYS="${PG_MIN_RETENTION_DAYS:-7}"

if [[ -n "${PG_SERVER_NAME:-}" ]]; then
  SERVER="$PG_SERVER_NAME"
else
  SERVER="$(az postgres flexible-server list -g "$RG" \
    --query "[?starts_with(name,'feasly-dev-pg')].name | [0]" -o tsv 2>/dev/null || true)"
fi

if [[ -z "${SERVER:-}" || "$SERVER" == "None" ]]; then
  echo "FAIL: no Postgres flexible server found in resource group '$RG' (set PG_SERVER_NAME to override discovery)" >&2
  exit 1
fi

backup_json="$(az postgres flexible-server show -n "$SERVER" -g "$RG" \
  --query "{retention: backup.backupRetentionDays, earliest: backup.earliestRestoreDate, geo: backup.geoRedundantBackup}" \
  -o json)"

retention="$(echo "$backup_json" | jq -r '.retention')"
earliest="$(echo "$backup_json" | jq -r '.earliest')"
geo="$(echo "$backup_json" | jq -r '.geo')"

echo "server=$SERVER retentionDays=$retention earliestRestore=$earliest geoRedundant=$geo"

failures=0

if ! [[ "$retention" =~ ^[0-9]+$ ]] || (( retention < MIN_RETENTION_DAYS )); then
  echo "FAIL: backup retention is '${retention}' days (minimum ${MIN_RETENTION_DAYS})" >&2
  failures=1
fi

if [[ -z "$earliest" || "$earliest" == "null" ]]; then
  echo "FAIL: earliestRestoreDate is missing — automated backups may not be running" >&2
  failures=1
else
  earliest_epoch="$(date -d "$earliest" +%s 2>/dev/null || echo 0)"
  now_epoch="$(date +%s)"
  age_hours=$(( (now_epoch - earliest_epoch) / 3600 ))
  # The earliest restore point only advances as backups complete; if it is
  # older than 48h the backup chain is stale or broken.
  if (( age_hours > 48 )); then
    echo "FAIL: earliest restore point is ${age_hours}h old (> 48h) — backup chain may be stale" >&2
    failures=1
  fi
fi

if (( failures == 0 )); then
  echo "OK: PITR-capable backups verified (retention ${retention}d >= ${MIN_RETENTION_DAYS}d, chain fresh)"
fi
exit "$failures"
