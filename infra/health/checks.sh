#!/usr/bin/env bash
# checks.sh — repo-owned health checks (HRD-06). THE single source of truth:
# the feasly-health-watch cron calls this; no forked check logic elsewhere.
#
# Env (all optional):
#   SITE_URL          default: https://victorious-meadow-0b295cc1e.6.azurestaticapps.net
#   API_URL           default: https://feasly-dev-api-4fhkep.azurewebsites.net
#   HEALTH_CHECK_CI   "true"|"false" — default "true"; set "false" in tests
#                     (the CI check needs `gh` + network).
#   REPO              default: ksingh31/feasly
#
# Output: one line per check:  CHECK <name> <ok|fail> <detail>
# Exit: 0 when every check passes, 1 when any fail.
#
# Notes:
# - Socrata (City of Calgary open data) is called from the FRONTEND
#   (apps/web), not the API, so there is no Socrata circuit-breaker on the
#   API to report. The site checks below cover the frontend's reachability.
# - /api/health never returns 500 for a sick database: it reports
#   {"status":"degraded","checks":{"database":"unreachable"}} with HTTP 200.
#   A degraded database IS an unhealthy API, so it fails this check.
set -uo pipefail

SITE_URL="${SITE_URL:-https://victorious-meadow-0b295cc1e.6.azurestaticapps.net}"
API_URL="${API_URL:-https://feasly-dev-api-4fhkep.azurewebsites.net}"
HEALTH_CHECK_CI="${HEALTH_CHECK_CI:-true}"
REPO="${REPO:-ksingh31/feasly}"

failures=0

report() { # report <name> <ok|fail> <detail...>
  local name="$1" status="$2"
  shift 2
  echo "CHECK $name $status $*"
  [[ "$status" == "ok" ]] || failures=1
}

http_code() { # http_code <url> -> code or "curl-failed"
  curl -s -o /dev/null -w "%{http_code}" --max-time 25 "$1" 2>/dev/null \
    || echo "curl-failed"
}

# 1-2. Site must answer 200 on / and /privacy.
for spec in "root /" "privacy /privacy"; do
  name="${spec%% *}"
  path="${spec##* }"
  code="$(http_code "${SITE_URL}${path}")"
  if [[ "$code" == "200" ]]; then
    report "site_${name}" ok "HTTP 200"
  else
    report "site_${name}" fail "HTTP ${code} (expected 200)"
  fi
done

# 3. API health: HTTP 200 + status ok + database ok.
api_body="$(curl -s --max-time 25 "${API_URL}/api/health" 2>/dev/null || true)"
api_code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 "${API_URL}/api/health" 2>/dev/null || echo "curl-failed")"
if [[ "$api_code" != "200" ]]; then
  report "api_health" fail "HTTP ${api_code} (expected 200)"
elif ! echo "$api_body" | jq -e . >/dev/null 2>&1; then
  report "api_health" fail "non-JSON body"
else
  api_status="$(echo "$api_body" | jq -r '.status // "missing"')"
  db_state="$(echo "$api_body" | jq -r '.checks.database // "missing"')"
  if [[ "$api_status" != "ok" ]]; then
    report "api_health" fail "status=${api_status} (expected ok)"
  elif [[ "$db_state" == "missing" ]]; then
    report "api_health" fail "no checks.database field — dependency health not reported"
  elif [[ "$db_state" != "ok" ]]; then
    report "api_health" fail "checks.database=${db_state}"
  else
    report "api_health" ok "status=ok database=ok"
  fi
fi

# 4. Latest main-branch CI: alert only on completed non-success
# (in_progress/queued are normal during active dev).
if [[ "$HEALTH_CHECK_CI" == "true" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    report "main_ci" fail "gh CLI unavailable"
  else
    run_json="$(gh run list --repo "$REPO" --branch main --limit 1 \
      --json status,conclusion 2>/dev/null || echo "")"
    if [[ -z "$run_json" || "$run_json" == "[]" ]]; then
      report "main_ci" fail "could not query CI runs"
    else
      rstatus="$(echo "$run_json" | jq -r '.[0].status // "unknown"')"
      rconcl="$(echo "$run_json" | jq -r '.[0].conclusion // ""')"
      case "$rstatus" in
        completed)
          if [[ "$rconcl" == "success" ]]; then
            report "main_ci" ok "latest main run succeeded"
          else
            report "main_ci" fail "latest main run concluded '${rconcl:-none}'"
          fi
          ;;
        in_progress|queued|waiting|requested|pending)
          report "main_ci" ok "run ${rstatus} (transient)"
          ;;
        *)
          report "main_ci" fail "unexpected run state '${rstatus}'"
          ;;
      esac
    fi
  fi
fi

exit "$failures"
