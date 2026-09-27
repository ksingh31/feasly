#!/usr/bin/env bash
# check-backup-bicep.sh — no-auth static check for HRD-04.
#
# Asserts the Bicep IaC declares PITR-capable backup settings on the Postgres
# (retention >= 7 days). No Azure access needed — pure repo analysis, so it
# runs in CI without the OIDC login that the live `backup-config` job needs.
# The live config (actual retention + chain freshness) is still asserted by
# infra/health/check-postgres-backup.sh in CI's backup-config job.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BICEP="$ROOT/infra/bicep/modules/postgres.bicep"
MIN_DAYS=7

[[ -f "$BICEP" ]] || { echo "FAIL: $BICEP not found" >&2; exit 1; }

# The module's `backupRetentionDays` param default is the declared retention.
retention="$(grep -E '^\s*param backupRetentionDays int' "$BICEP" \
  | grep -oE '= [0-9]+' | grep -oE '[0-9]+' || true)"
[[ -n "$retention" ]] || { echo "FAIL: could not find 'param backupRetentionDays int' in $BICEP" >&2; exit 1; }

echo "bicep declared backupRetentionDays=$retention (minimum $MIN_DAYS)"

if (( retention < MIN_DAYS )); then
  echo "FAIL: declared retention ${retention}d < ${MIN_DAYS}d — PITR window too short" >&2
  exit 1
fi

geo="$(grep -E "geoRedundantBackup" "$BICEP" | head -1 || true)"
echo "geoRedundantBackup declaration: ${geo:-<not set>}"

echo "OK: Bicep declares PITR-capable backup settings (retention ${retention}d >= ${MIN_DAYS}d)"
