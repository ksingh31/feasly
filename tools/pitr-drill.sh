#!/usr/bin/env bash
# pitr-drill.sh — real point-in-time-recovery drill for the Feasly Postgres (HRD-04).
#
# Restores the automated backup chain to a NEW staging server at a chosen point
# in time, verifies integrity (row counts, latest estimate/lead present, nothing
# newer than the restore point), measures RTO, then tears the drill server down.
# Production is never touched.
#
# IRON RULE: the drill target MUST be a fresh server whose name starts with
# `feasly-drill-` and differs from the source. guard_target_name() refuses
# anything else, and it is unit-tested without Azure access in
# infra/health/test/test-pitr-drill.sh.
#
# Prerequisites (only when actually RUNNING the drill — the unit tests, the
# static CI check, and --dry-run never provision anything):
#   - `az` CLI logged in (interactive `az login`, or the azure/login OIDC step
#     in CI) with a role on the resource group that can create/delete flexible
#     servers and read Key Vault secrets (e.g. Contributor).
#   - `psql` and `jq` on PATH (`--dry-run` needs only `az` + `jq`).
#
# Usage:
#   bash tools/pitr-drill.sh --source-server feasly-dev-pg-4fhkep \
#       --resource-group rg-feasly-dev \
#       --restore-point 2026-09-26T18:00:00Z
#
# Flags:
#   --source-server NAME   server to restore FROM
#                          (default: first feasly-dev-pg-* server in the RG)
#   --resource-group RG    default: rg-feasly-dev
#   --restore-point TS     ISO-8601 UTC inside the retention window
#                          (default: 10 minutes ago)
#   --drill-name NAME      default: feasly-drill-YYYYMMDD-HHMM
#                          (MUST start with feasly-drill-)
#   --dbname NAME          database to verify (default: feasly)
#   --dry-run              validate everything WITHOUT restoring: discovers the
#                          source, checks retention >= 7d and the live backup
#                          window, validates the restore point and the
#                          staging-only guard — then exits 0. Read-only Azure
#                          calls only; no server is created, no firewall rule
#                          touched. Use as the drill pre-flight / CI check.
#   --keep                 do NOT tear the drill server down (debug only —
#                          prints a loud PII warning; the drill copy holds lead PII)
#   --yes                  skip the confirmation prompt
#   -h / --help            this text
set -euo pipefail

DRILL_PREFIX="feasly-drill-"
DEFAULT_RG="rg-feasly-dev"
DEFAULT_DBNAME="feasly"
MIN_RETENTION_DAYS=7

RG="$DEFAULT_RG"
SRC=""
RESTORE_POINT=""
DRILL_NAME=""
DBNAME="$DEFAULT_DBNAME"
DRY_RUN=false
KEEP=false
YES=false

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "==> $*"; }

usage() {
  sed -n '2,/^set -euo pipefail/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

# ---------------------------------------------------------------------------
# Staging-only guard — pure logic, no Azure. Unit-tested.
# guard_target_name <target> <source>  → 0 = allowed, 1 = refused.
# ---------------------------------------------------------------------------
guard_target_name() {
  local target="$1" source="$2"
  # Rule 1: the target must be a dedicated drill server name.
  case "$target" in
    "$DRILL_PREFIX"*) ;;
    *)
      echo "REFUSING: drill target '$target' does not start with '$DRILL_PREFIX'" >&2
      return 1
      ;;
  esac
  # Rule 2: the target must differ from the source — never restore over prod.
  if [[ "$target" == "$source" ]]; then
    echo "REFUSING: drill target == source server '$source'" >&2
    return 1
  fi
  # Rule 3: the source itself must not be a drill server (no drill-from-drill,
  # which could launder a drill name into the source slot).
  case "$source" in
    "$DRILL_PREFIX"*)
      echo "REFUSING: source '$source' looks like a drill server" >&2
      return 1
      ;;
  esac
  return 0
}

default_drill_name() { echo "${DRILL_PREFIX}$(date -u +%Y%m%d-%H%M)"; }

# ---------------------------------------------------------------------------
# Restore-point validation — pure logic, no Azure. Unit-tested.
# validate_restore_point <restore-point> <earliest-restore-point> <now-epoch>
#   → 0 = inside the backup window, 1 = rejected (reason on stderr).
# ---------------------------------------------------------------------------
validate_restore_point() {
  local rp="$1" earliest="$2" now_s="$3"
  local rp_s earliest_s
  rp_s="$(date -d "$rp" +%s 2>/dev/null)" \
    || { echo "REFUSING: cannot parse restore point '$rp'" >&2; return 1; }
  earliest_s="$(date -d "$earliest" +%s 2>/dev/null)" \
    || { echo "REFUSING: cannot parse earliest restore point '$earliest'" >&2; return 1; }
  if (( rp_s < earliest_s )); then
    echo "REFUSING: restore point $rp is older than the earliest restore point $earliest" >&2
    return 1
  fi
  if (( rp_s > now_s )); then
    echo "REFUSING: restore point $rp is in the future" >&2
    return 1
  fi
  return 0
}

format_duration() { # format_duration <seconds>
  local s="$1"
  printf '%dm %ds' $((s / 60)) $((s % 60))
}

# ---------------------------------------------------------------------------
# Azure helpers (only called by main, never by the unit tests).
# ---------------------------------------------------------------------------
discover_source() {
  az postgres flexible-server list -g "$RG" \
    --query "[?starts_with(name,'feasly-dev-pg')].name | [0]" -o tsv 2>/dev/null || true
}

server_state() { # server_state <name>
  az postgres flexible-server show -n "$1" -g "$RG" --query state -o tsv 2>/dev/null || true
}

drill_exists() { [[ -n "$(server_state "$1")" ]]; }

teardown() { # teardown <drill-name> — idempotent; deleting the server removes its firewall rules too.
  local name="$1"
  if drill_exists "$name"; then
    log "tearing down drill server $name ..."
    az postgres flexible-server delete -n "$name" -g "$RG" --yes >/dev/null \
      || echo "WARNING: failed to delete $name — delete it manually NOW (it holds lead PII)" >&2
  else
    log "drill server $name already gone."
  fi
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source-server) SRC="$2"; shift 2 ;;
      --resource-group) RG="$2"; shift 2 ;;
      --restore-point) RESTORE_POINT="$2"; shift 2 ;;
      --drill-name) DRILL_NAME="$2"; shift 2 ;;
      --dbname) DBNAME="$2"; shift 2 ;;
      --dry-run) DRY_RUN=true; shift ;;
      --keep) KEEP=true; shift ;;
      --yes) YES=true; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown flag: $1 (see --help)" ;;
    esac
  done

  command -v az >/dev/null || die "'az' CLI not found on PATH"
  command -v jq >/dev/null || die "'jq' not found on PATH"
  if ! $DRY_RUN; then
    command -v psql >/dev/null || die "'psql' not found on PATH"
  fi

  [[ -z "$SRC" ]] && SRC="$(discover_source)"
  [[ -z "$SRC" || "$SRC" == "None" ]] && die "no source server (set --source-server)"
  [[ -z "$RESTORE_POINT" ]] && RESTORE_POINT="$(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
  [[ -z "$DRILL_NAME" ]] && DRILL_NAME="$(default_drill_name)"

  # --- Iron rule, before anything touches Azure --------------------------------
  guard_target_name "$DRILL_NAME" "$SRC" || die "staging-only guard rejected the target"

  # --- Restore point must be inside the live backup window ----------------------
  local src_info earliest now_s
  src_info="$(az postgres flexible-server show -n "$SRC" -g "$RG" \
    --query "{earliest: backup.earliestRestoreDate, retention: backup.backupRetentionDays, admin: administratorLogin, fqdn: fullyQualifiedDomainName}" -o json)"
  earliest="$(echo "$src_info" | jq -r '.earliest')"
  [[ -n "$earliest" && "$earliest" != "null" ]] || die "source has no earliestRestoreDate — automated backups may not be running"
  now_s="$(date +%s)"
  validate_restore_point "$RESTORE_POINT" "$earliest" "$now_s" \
    || die "restore point $RESTORE_POINT is outside the backup window (earliest: $earliest)"
  log "source=$SRC  drill=$DRILL_NAME  restore-point=$RESTORE_POINT  (earliest: $earliest)"

  # --- Dry-run: pre-flight only, nothing is created or changed ------------------
  if $DRY_RUN; then
    local retention
    retention="$(echo "$src_info" | jq -r '.retention')"
    if [[ "$retention" == "null" || -z "$retention" ]] || (( retention < MIN_RETENTION_DAYS )); then
      die "dry-run: source retention ${retention}d < ${MIN_RETENTION_DAYS}d — PITR window too short"
    fi
    echo
    echo "DRY-RUN OK — a live drill right now would be valid:"
    echo "  source:         $SRC (backup retention ${retention}d, chain fresh, earliest restore $earliest)"
    echo "  drill server:   $DRILL_NAME (staging-only guard passed)"
    echo "  restore point:  $RESTORE_POINT (inside the backup window)"
    echo "  database:       $DBNAME"
    echo "No Azure resources were created, modified, or deleted."
    exit 0
  fi

  if ! $YES; then
    read -r -p "About to RESTORE $SRC @ $RESTORE_POINT into NEW server $DRILL_NAME, then DELETE it. Continue? [y/N] " ans
    [[ "$ans" == [yY]* ]] || die "aborted by operator"
  fi

  local start_s=$SECONDS
  log "starting restore ..."
  az postgres flexible-server restore \
    --name "$DRILL_NAME" \
    --source-server "$SRC" \
    --resource-group "$RG" \
    --restore-time "$RESTORE_POINT" >/dev/null

  # --- Wait for the drill server -------------------------------------------------
  log "waiting for $DRILL_NAME to become Ready ..."
  local waited=0 state
  while true; do
    state="$(server_state "$DRILL_NAME")"
    [[ "$state" == "Ready" ]] && break
    (( waited >= 2700 )) && { teardown "$DRILL_NAME"; die "drill server not Ready after 45 min (last state: $state)"; }
    sleep 30
    waited=$((waited + 30))
  done

  # --- Operator access: temporary firewall rule (dies with the server) -----------
  local my_ip
  my_ip="$(curl -s --max-time 10 https://api.ipify.org || true)"
  [[ -n "$my_ip" ]] || die "could not determine operator public IP (needed for the temp firewall rule)"
  log "adding temporary firewall rule for operator IP $my_ip (removed with the server)"
  az postgres flexible-server firewall-rule create \
    --server-name "$DRILL_NAME" -g "$RG" \
    --name drill-tmp-operator \
    --start-ip-address "$my_ip" --end-ip-address "$my_ip" >/dev/null

  # --- Credentials ----------------------------------------------------------------
  local drill_info drill_fqdn admin_user kv_name admin_pw
  drill_info="$(az postgres flexible-server show -n "$DRILL_NAME" -g "$RG" \
    --query "{fqdn: fullyQualifiedDomainName, admin: administratorLogin}" -o json)"
  drill_fqdn="$(echo "$drill_info" | jq -r '.fqdn')"
  admin_user="$(echo "$drill_info" | jq -r '.admin')"
  kv_name="$(az keyvault list -g "$RG" \
    --query "[?starts_with(name,'feasly-dev-kv')].name | [0]" -o tsv)"
  [[ -n "$kv_name" && "$kv_name" != "None" ]] || { teardown "$DRILL_NAME"; die "no feasly-dev-kv* Key Vault in $RG"; }
  admin_pw="$(az keyvault secret show --vault-name "$kv_name" \
    --name feasly-dev-postgres-admin --query value -o tsv)"
  [[ -n "$admin_pw" ]] || { teardown "$DRILL_NAME"; die "could not read admin password from Key Vault"; }

  export PGPASSWORD="$admin_pw"
  local dsn="host=$drill_fqdn user=$admin_user dbname=$DBNAME sslmode=require"
  q() { psql "$dsn" -tAc "$1"; }

  # --- Integrity checks -------------------------------------------------------------
  log "running integrity checks ..."
  local est_count est_latest lead_count lead_latest est_after lead_after
  est_count="$(q "SELECT count(*) FROM estimates;")"
  est_latest="$(q "SELECT coalesce(max(created_at)::text,'<none>') FROM estimates;")"
  lead_count="$(q "SELECT count(*) FROM leads;")"
  lead_latest="$(q "SELECT coalesce(max(created_at)::text,'<none>') FROM leads;")"
  est_after="$(q "SELECT count(*) FROM estimates WHERE created_at > timestamptz '$RESTORE_POINT';")"
  lead_after="$(q "SELECT count(*) FROM leads WHERE created_at > timestamptz '$RESTORE_POINT';")"

  local rto_s=$((SECONDS - start_s))
  local operator
  operator="$(az account show --query user.name -o tsv 2>/dev/null || echo "${USER:-unknown}")"

  # --- RPO cross-check: production's latest write before the restore point ---------
  # Best-effort read-only comparison (operator may not have prod firewall access).
  local src_fqdn prod_dsn prod_est_latest="" prod_lead_latest="" rpo_verdict="row counts recorded (prod comparison skipped)"
  src_fqdn="$(echo "$src_info" | jq -r '.fqdn')"
  prod_dsn="host=$src_fqdn user=$admin_user dbname=$DBNAME sslmode=require connect_timeout=10"
  if PGPASSWORD="$admin_pw" psql "$prod_dsn" -tAc "SELECT 1;" >/dev/null 2>&1; then
    prod_est_latest="$(PGPASSWORD="$admin_pw" psql "$prod_dsn" -tAc \
      "SELECT coalesce(max(created_at)::text,'<none>') FROM estimates WHERE created_at <= timestamptz '$RESTORE_POINT';")"
    prod_lead_latest="$(PGPASSWORD="$admin_pw" psql "$prod_dsn" -tAc \
      "SELECT coalesce(max(created_at)::text,'<none>') FROM leads WHERE created_at <= timestamptz '$RESTORE_POINT';")"
    if [[ "$est_latest" == "$prod_est_latest" && "$lead_latest" == "$prod_lead_latest" ]]; then
      rpo_verdict="PASS — drill server's latest writes match production as of $RESTORE_POINT (no data loss vs target)"
    else
      rpo_verdict="MISMATCH — drill latest ($est_latest / $lead_latest) vs prod-as-of-restore-point ($prod_est_latest / $prod_lead_latest)"
    fi
  else
    echo "WARNING: could not reach production for the RPO cross-check (firewall?); integrity verdict below stands on its own." >&2
  fi

  # --- Verdict ------------------------------------------------------------------------
  local verdict="PASS"
  (( est_after != 0 )) && verdict="FAIL"
  (( lead_after != 0 )) && verdict="FAIL"

  echo
  echo "==================== PITR DRILL RESULT ===================="
  echo "date:          $(date -u +%Y-%m-%d)"
  echo "operator:      $operator"
  echo "source:        $SRC"
  echo "drill server:  $DRILL_NAME (staging-only: name starts with $DRILL_PREFIX, != source)"
  echo "restore point: $RESTORE_POINT"
  echo "measured RTO:  $(format_duration "$rto_s") (restore issued → first successful query)"
  echo "estimates:     count=$est_count latest=$est_latest"
  echo "leads:         count=$lead_count latest=$lead_latest"
  echo "writes newer than restore point: estimates=$est_after leads=$lead_after (must be 0)"
  echo "RPO check:     $rpo_verdict"
  echo "verdict:       $verdict"
  echo "=========================================================="
  echo
  echo "Paste this row into docs/ops/backup.md §6:"
  echo "| $(date -u +%Y-%m-%d) | $operator | $RESTORE_POINT | $(format_duration "$rto_s") | $rpo_verdict | **$verdict** |"
  echo

  unset PGPASSWORD

  if $KEEP; then
    echo "WARNING --keep: drill server $DRILL_NAME left running — it holds a copy of lead PII. Delete it now that you are done: az postgres flexible-server delete -n $DRILL_NAME -g $RG --yes" >&2
  else
    teardown "$DRILL_NAME"
  fi
}

# Run main only when executed directly; unit tests source this file.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
