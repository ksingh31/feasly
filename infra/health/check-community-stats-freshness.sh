#!/usr/bin/env bash
# check-community-stats-freshness.sh — NBH-05 AC4: fail loudly when the
# monthly community-stats refresh stops running.
#
# Read-only: two SELECTs against the Feasly Postgres, nothing else.
# Fails (exit 1) when any community_stats.refreshed_at is older than 45
# days, or when the table is empty (the seed/refresh never produced rows).
#
# The 45-day threshold MUST match STALE_AFTER_DAYS in
# apps/api/src/routes/community-stats.route.ts (the API's `stale` flag).
# A unit test (apps/api/test/community-stats-freshness-guard.test.ts)
# fails CI if this script's interval and the route constant drift apart.
#
# Connection: libpq PG* env vars (PGHOST, PGPORT, PGDATABASE, PGUSER,
# PGPASSWORD). When PGPASSWORD is unset, the script discovers the server
# and Key Vault via `az` (same pattern as check-postgres-backup.sh) —
# used by CI (.github/workflows/ci.yml -> community-stats-freshness job).
#
# Env overrides (all optional):
#   PG_RESOURCE_GROUP   default: rg-feasly-dev
#   PG_SERVER_NAME      default: discover first server starting with feasly-dev-pg
#   PG_KEY_VAULT_NAME   default: discover first vault starting with feasly-dev-kv
#   PG_SECRET_NAME      default: feasly-dev-postgres-admin
#   PGDATABASE          default: feasly
#   STALE_AFTER_DAYS    default: 45 (must match the API route constant)
#
# Local: PGHOST=... PGUSER=... PGPASSWORD=... PGDATABASE=feasly \
#   bash infra/health/check-community-stats-freshness.sh
set -euo pipefail

RG="${PG_RESOURCE_GROUP:-rg-feasly-dev}"
STALE_AFTER_DAYS="${STALE_AFTER_DAYS:-45}"

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found — installing postgresql-client (CI runner)..." >&2
  sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-client
fi

if [[ -z "${PGPASSWORD:-}" ]]; then
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

  if [[ -n "${PG_KEY_VAULT_NAME:-}" ]]; then
    VAULT="$PG_KEY_VAULT_NAME"
  else
    VAULT="$(az keyvault list -g "$RG" \
      --query "[?starts_with(name,'feasly-dev-kv')].name | [0]" -o tsv 2>/dev/null || true)"
  fi
  if [[ -z "${VAULT:-}" || "$VAULT" == "None" ]]; then
    echo "FAIL: no Key Vault found in resource group '$RG' (set PG_KEY_VAULT_NAME to override discovery)" >&2
    exit 1
  fi

  SECRET_NAME="${PG_SECRET_NAME:-feasly-dev-postgres-admin}"
  PGPASSWORD="$(az keyvault secret show --vault-name "$VAULT" --name "$SECRET_NAME" \
    --query value -o tsv 2>/dev/null || true)"
  if [[ -z "${PGPASSWORD:-}" ]]; then
    echo "FAIL: could not read secret '$SECRET_NAME' from vault '$VAULT'" >&2
    exit 1
  fi
  export PGPASSWORD

  PGHOST="$(az postgres flexible-server show -n "$SERVER" -g "$RG" \
    --query fullyQualifiedDomainName -o tsv 2>/dev/null || true)"
  if [[ -z "${PGHOST:-}" || "$PGHOST" == "None" ]]; then
    echo "FAIL: could not resolve FQDN for server '$SERVER'" >&2
    exit 1
  fi
  export PGHOST
fi

export PGPORT="${PGPORT:-5432}"
export PGDATABASE="${PGDATABASE:-feasly}"
export PGUSER="${PGUSER:-feaslyadmin}"
# Never log the password: psql reads PGPASSWORD from the environment.
export PGSSLMODE="${PGSSLMODE:-require}"

stats="$(psql -t -A -F'|' -c \
  "SELECT count(*), min(refreshed_at) FROM community_stats \
   WHERE refreshed_at < now() - interval '${STALE_AFTER_DAYS} days';" \
  2>/dev/null || true)"
if [[ -z "$stats" ]]; then
  echo "FAIL: could not query community_stats (connection or permissions)" >&2
  exit 1
fi

stale_rows="${stats%%|*}"
latest_stale="${stats##*|}"

total="$(psql -t -A -c "SELECT count(*) FROM community_stats;" 2>/dev/null || echo "")"
if [[ -z "$total" ]]; then
  echo "FAIL: could not query community_stats (connection or permissions)" >&2
  exit 1
fi

failures=0

if ! [[ "$total" =~ ^[0-9]+$ ]] || (( total == 0 )); then
  echo "FAIL: community_stats is empty — the seed/refresh never produced rows" >&2
  failures=1
fi

if [[ "$stale_rows" =~ ^[0-9]+$ ]] && (( stale_rows > 0 )); then
  echo "FAIL: ${stale_rows} community_stats row(s) have refreshed_at older than ${STALE_AFTER_DAYS} days (oldest stale: ${latest_stale}) — the monthly refresh timer may have stopped running" >&2
  failures=1
fi

if (( failures == 0 )); then
  echo "OK: community_stats fresh (${total} rows, none older than ${STALE_AFTER_DAYS} days)"
fi
exit "$failures"
