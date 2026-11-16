#!/usr/bin/env bash
# check-community-stats-freshness.sh — NBH-05 AC4: fail loudly when the
# monthly community-stats refresh stops running.
#
# Database access is read-only: two SELECTs against the Feasly Postgres.
# Azure access is NOT read-only: the runner-reachability fallback below
# creates/deletes Postgres firewall rules, so the CI identity needs
# Microsoft.DBforPostgreSQL/flexibleServers/firewallRules/write + delete.
# Do not narrow it to Reader.
# Fails (exit 1) when any community_stats.refreshed_at is older than 45
# days, or when the table is empty (the seed/refresh never produced rows).
#
# The 45-day threshold MUST match STALE_AFTER_DAYS in
# apps/api/src/routes/community-stats.route.ts (the API's `stale` flag).
# A unit test (apps/api/test/community-stats-freshness-guard.test.ts)
# fails CI if this script's interval and the route constant drift apart.
#
# Connection: libpq PG* env vars (PGHOST, PGPORT, PGDATABASE, PGUSER,
# PGPASSWORD). The password comes from POSTGRES_PASSWORD when set (the same
# GitHub secret the CD db:migrate step uses), else the script discovers the
# server and Key Vault via `az` (same pattern as check-postgres-backup.sh) —
# used by CI (.github/workflows/ci.yml -> community-stats-freshness job).
#
# Env overrides (all optional):
#   POSTGRES_PASSWORD   preferred password source (CD-proven GitHub secret)
#   PG_RESOURCE_GROUP   default: rg-feasly-dev
#   PG_SERVER_NAME      default: discover first server starting with feasly-dev-pg
#   PG_KEY_VAULT_NAME   default: discover first vault starting with feasly-dev-kv
#   PG_SECRET_NAME      default: feasly-dev-postgres-admin
#   PGDATABASE          default: feasly
#   STALE_AFTER_DAYS    default: 45 (must match the API route constant)
#   PGCONNECT_TIMEOUT   default: 15 (seconds per connection attempt)
#   PG_TEMP_FIREWALL    auto (default) | 1 | 0 — see "Runner reachability"
#
# Runner reachability (#951): the server only allows Azure-originated
# traffic (the AllowAzureServices 0.0.0.0 rule in postgres.bicep). Some
# GitHub-hosted runners egress from IPs that rule does not cover, so every
# psql attempt from that runner times out — retries on the same runner can
# never succeed. When the first connection fails and we are in GitHub
# Actions (or PG_TEMP_FIREWALL=1), the script adds a temporary firewall
# rule for this runner's public IP only (/32, named ci-freshness-<epoch>-…),
# re-runs the queries, and deletes the rule on exit. Leftover rules from a
# killed job are swept on the next run once they are an hour old.
# Firewall rules are free; no SKU or resource is created. PG_TEMP_FIREWALL=0
# disables this.
#
# Local: PGHOST=... PGUSER=... PGPASSWORD=... PGDATABASE=feasly \
#   bash infra/health/check-community-stats-freshness.sh
set -euo pipefail

RG="${PG_RESOURCE_GROUP:-rg-feasly-dev}"
STALE_AFTER_DAYS="${STALE_AFTER_DAYS:-45}"

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found — installing postgresql-client..." >&2
  if ! sudo apt-get update -qq 2>&1 | tail -1; then
    echo "WARN: apt-get update had issues, attempting install anyway" >&2
  fi
  sudo apt-get install -y -qq --no-install-recommends postgresql-client
  command -v psql >/dev/null 2>&1 || {
    echo "FAIL: could not install postgresql-client" >&2
    exit 1
  }
fi

SERVER="${PG_SERVER_NAME:-}"
if [[ -z "${PGHOST:-}" ]]; then
  # Server FQDN always comes from az discovery (unless PGHOST is preset).
  if [[ -z "$SERVER" ]]; then
    SERVER="$(az postgres flexible-server list -g "$RG" \
      --query "[?starts_with(name,'feasly-dev-pg')].name | [0]" -o tsv 2>/dev/null || true)"
  fi
  if [[ -z "${SERVER:-}" || "$SERVER" == "None" ]]; then
    echo "FAIL: no Postgres flexible server found in resource group '$RG' (set PG_SERVER_NAME to override discovery)" >&2
    exit 1
  fi
  PGHOST="$(az postgres flexible-server show -n "$SERVER" -g "$RG" \
    --query fullyQualifiedDomainName -o tsv 2>/dev/null || true)"
  if [[ -z "${PGHOST:-}" || "$PGHOST" == "None" ]]; then
    echo "FAIL: could not resolve FQDN for server '$SERVER'" >&2
    exit 1
  fi
  export PGHOST
elif [[ -z "$SERVER" && "$PGHOST" == *.postgres.database.azure.com ]]; then
  SERVER="${PGHOST%%.*}"
fi

if [[ -z "${PGPASSWORD:-}" ]]; then
  # CD-proven path first: the GitHub POSTGRES_PASSWORD secret.
  if [[ -n "${POSTGRES_PASSWORD:-}" ]]; then
    PGPASSWORD="$POSTGRES_PASSWORD"
    echo "using POSTGRES_PASSWORD for Postgres auth" >&2
  else
    echo "POSTGRES_PASSWORD unset — fetching password from Key Vault" >&2
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
  fi
  export PGPASSWORD
fi

export PGPORT="${PGPORT:-5432}"
export PGDATABASE="${PGDATABASE:-feasly}"
export PGUSER="${PGUSER:-feaslyadmin}"
# Never log the password: psql reads PGPASSWORD from the environment.
export PGSSLMODE="${PGSSLMODE:-require}"
# Fail an unreachable attempt fast (libpq's default waits ~2 min per try).
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"

FW_PREFIX="ci-freshness-"
FW_RULE=""
FW_MAX_AGE_SECONDS=3600

fw_cleanup() {
  if [[ -n "$FW_RULE" ]]; then
    if az postgres flexible-server firewall-rule delete -g "$RG" --server-name "$SERVER" \
        --name "$FW_RULE" --yes >/dev/null 2>&1; then
      echo "removed temporary firewall rule $FW_RULE" >&2
    else
      echo "WARN: could not remove temporary firewall rule $FW_RULE (the next run sweeps it)" >&2
    fi
    FW_RULE=""
  fi
}

# Delete ci-freshness-<epoch>-* rules older than FW_MAX_AGE_SECONDS (a job
# killed before its EXIT trap ran). Best effort; never fails the check.
fw_sweep() {
  local now name epoch
  now="$(date +%s)"
  while IFS= read -r name; do
    [[ "$name" == "$FW_PREFIX"* ]] || continue
    epoch="${name#"$FW_PREFIX"}"; epoch="${epoch%%-*}"
    [[ "$epoch" =~ ^[0-9]+$ ]] || continue
    if (( now - epoch > FW_MAX_AGE_SECONDS )); then
      az postgres flexible-server firewall-rule delete -g "$RG" --server-name "$SERVER" \
        --name "$name" --yes >/dev/null 2>&1 \
        && echo "swept stale firewall rule $name" >&2 || true
    fi
  done < <(az postgres flexible-server firewall-rule list -g "$RG" --server-name "$SERVER" \
             --query "[].name" -o tsv 2>/dev/null || true)
}

# Open a /32 rule for this runner's public IP. Returns 1 when not possible.
fw_open() {
  local ip
  [[ -n "$SERVER" ]] || { echo "WARN: server name unknown — cannot add a runner firewall rule" >&2; return 1; }
  ip="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  if ! [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    echo "WARN: could not determine this runner's public IPv4 — cannot add a firewall rule" >&2
    return 1
  fi
  fw_sweep
  local name
  name="${FW_PREFIX}$(date +%s)-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-$$}"
  name="${name:0:128}"
  trap fw_cleanup EXIT
  trap 'fw_cleanup; exit 130' INT TERM
  if ! az postgres flexible-server firewall-rule create -g "$RG" --server-name "$SERVER" \
      --name "$name" --start-ip-address "$ip" --end-ip-address "$ip" >/dev/null; then
    echo "WARN: could not create temporary firewall rule for $ip" >&2
    return 1
  fi
  FW_RULE="$name"
  echo "runner $ip not admitted by the server firewall — added temporary rule $name" >&2
}

fw_wanted() {
  case "${PG_TEMP_FIREWALL:-auto}" in
    1|true) return 0 ;;
    0|false) return 1 ;;
    *) [[ "${GITHUB_ACTIONS:-}" == "true" ]] ;;
  esac
}

# Do NOT silence psql stderr: a connection failure must show the real
# libpq error in the CI log, not a generic "could not query".
# Connection errors only are retried (3 attempts, 5s/10s back-off): a
# transient Azure/PgBouncer blip must not fail the check. Stale data is a
# successful query and still fails below — the check is not weakened.
# With a fresh temporary firewall rule, allow a few more attempts: the
# rule can take up to ~1 min to take effect.
Q_ATTEMPTS=3
q() {
  local out attempt
  for (( attempt = 1; attempt <= Q_ATTEMPTS; attempt++ )); do
    if out="$(psql -t -A -F'|' -c "$1")" && [[ -n "$out" ]]; then
      printf '%s' "$out"; return 0
    fi
    (( attempt < Q_ATTEMPTS )) && { echo "psql attempt $attempt failed — retrying" >&2; sleep $((attempt * 5)); }
  done
  return 1
}

# Reachability probe: one quick attempt. If this runner is not admitted,
# open a temporary rule for it instead of burning retries on a dead route.
if ! psql -t -A -c "SELECT 1;" >/dev/null && fw_wanted; then
  if fw_open; then
    Q_ATTEMPTS=6
  fi
fi

stats="$(q "SELECT count(*), min(refreshed_at) FROM community_stats \
   WHERE refreshed_at < now() - interval '${STALE_AFTER_DAYS} days';" || true)"
if [[ -z "$stats" ]]; then
  echo "FAIL: could not query community_stats (see psql error above)" >&2
  exit 1
fi

stale_rows="${stats%%|*}"
latest_stale="${stats##*|}"

total="$(q "SELECT count(*) FROM community_stats;" || echo "")"
if [[ -z "$total" ]]; then
  echo "FAIL: could not query community_stats (see psql error above)" >&2
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
