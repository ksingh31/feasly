#!/usr/bin/env bash
# test-pitr-drill.sh — unit tests for tools/pitr-drill.sh (HRD-04).
# Everything here is pure logic: no Azure, no network, no psql.
# Fails loudly on the first broken expectation.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

pass=0
fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
bad() { fail=$((fail + 1)); echo "FAIL - $1"; }

# Source only: the script's main() runs solely when executed directly.
# shellcheck disable=SC1091
source "$ROOT/tools/pitr-drill.sh"

# --- guard_target_name: happy path ------------------------------------------
guard_target_name "feasly-drill-20260926-1800" "feasly-dev-pg-4fhkep" \
  && ok "guard: accepts well-formed drill name" \
  || bad "guard: rejected a well-formed drill name"

# --- guard_target_name: refusals --------------------------------------------
guard_target_name "feasly-dev-pg-4fhkep" "feasly-dev-pg-4fhkep" 2>/dev/null \
  && bad "guard: allowed target == source (restore-over-prod!)" \
  || ok "guard: refuses target == source"

guard_target_name "feasly-prod-restore" "feasly-dev-pg-4fhkep" 2>/dev/null \
  && bad "guard: allowed non-drill-prefixed target" \
  || ok "guard: refuses target without the $DRILL_PREFIX prefix"

guard_target_name "" "feasly-dev-pg-4fhkep" 2>/dev/null \
  && bad "guard: allowed empty target" \
  || ok "guard: refuses empty target"

guard_target_name "feasly-drill-20260926-1800" "feasly-drill-20260926-1700" 2>/dev/null \
  && bad "guard: allowed drill-from-drill source" \
  || ok "guard: refuses a drill-looking source server"

guard_target_name "feasly-drill-" "feasly-dev-pg-4fhkep" 2>/dev/null \
  && ok "guard: accepts bare prefix (operator may name it freely)" \
  || bad "guard: rejected bare '$DRILL_PREFIX' target"

# --- default_drill_name: prefix contract ------------------------------------
name="$(default_drill_name)"
case "$name" in
  "$DRILL_PREFIX"*) ok "default_drill_name: starts with $DRILL_PREFIX ($name)" ;;
  *) bad "default_drill_name: '$name' missing the $DRILL_PREFIX prefix" ;;
esac
guard_target_name "$name" "feasly-dev-pg-4fhkep" 2>/dev/null \
  && ok "default_drill_name: passes the guard" \
  || bad "default_drill_name: fails the guard"

# --- format_duration ----------------------------------------------------------
[[ "$(format_duration 90)" == "1m 30s" ]] \
  && ok "format_duration: 90s -> 1m 30s" \
  || bad "format_duration: got '$(format_duration 90)'"
[[ "$(format_duration 45)" == "0m 45s" ]] \
  && ok "format_duration: 45s -> 0m 45s" \
  || bad "format_duration: got '$(format_duration 45)'"

# --- script self-consistency: restore must use --restore-time ------------------
# (verified against current Azure CLI docs 2026-09-26; --restore-point-in-time
# is NOT a parameter of `az postgres flexible-server restore`).
grep -q -- '--restore-time' "$ROOT/tools/pitr-drill.sh" \
  && ok "script: restore uses --restore-time" \
  || bad "script: missing --restore-time on the restore command"
grep -q 'guard_target_name "\$DRILL_NAME" "\$SRC"' "$ROOT/tools/pitr-drill.sh" \
  && ok "script: main() enforces the staging-only guard" \
  || bad "script: main() does not call the staging-only guard"

echo
echo "pass=$pass fail=$fail"
[[ $fail -eq 0 ]]
