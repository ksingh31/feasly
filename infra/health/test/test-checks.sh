#!/usr/bin/env bash
# test-checks.sh — tests for the repo-owned health checks (HRD-06).
# Everything is mocked (localhost HTTP server, fake `gh`); no network,
# no Azure, no real CI. Fails loudly on the first broken expectation.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PORT=18931
MOCK="$HERE/mock-server.py"

pass=0
fail=0
ok()   { pass=$((pass + 1)); echo "ok   - $1"; }
bad()  { fail=$((fail + 1)); echo "FAIL - $1"; }

mock_up() { # mock_up <mode>
  pkill -f "mock-server.py $PORT" 2>/dev/null || true
  python3 "$MOCK" "$PORT" "$1" &>/dev/null &
  for _ in $(seq 1 50); do
    curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" && return 0
    sleep 0.1
  done
  bad "mock server ($1) did not start"
  return 1
}
mock_down() { pkill -f "mock-server.py $PORT" 2>/dev/null || true; }

run_checks() { # run_checks <extra env...>
  SITE_URL="http://127.0.0.1:$PORT" \
  API_URL="http://127.0.0.1:$PORT" \
  HEALTH_CHECK_CI=false \
  bash "$ROOT/infra/health/checks.sh"
}

# --- 1. healthy mock: all green, exit 0 -------------------------------------
mock_up healthy
out="$(run_checks)"; code=$?
[[ $code -eq 0 ]] && ok "healthy: exit 0" || bad "healthy: exit $code"
echo "$out" | grep -q "CHECK site_root ok" && ok "healthy: site_root ok" \
  || bad "healthy: site_root line: $out"
echo "$out" | grep -q "CHECK site_privacy ok" && ok "healthy: site_privacy ok" \
  || bad "healthy: site_privacy line"
echo "$out" | grep -q "CHECK api_health ok" && ok "healthy: api_health ok" \
  || bad "healthy: api_health line"

# --- 2. degraded database -> fail, mentions database ------------------------
mock_up degraded-db
out="$(run_checks)"; code=$?
[[ $code -eq 1 ]] && ok "degraded-db: exit 1" || bad "degraded-db: exit $code"
echo "$out" | grep -q "CHECK api_health fail.*degraded" \
  && ok "degraded-db: api_health fails on degraded status" \
  || bad "degraded-db: api_health line: $out"

# --- 3. stub without checks.database -> fail --------------------------------
mock_up no-checks
out="$(run_checks)"; code=$?
[[ $code -eq 1 ]] && ok "no-checks: exit 1" || bad "no-checks: exit $code"
echo "$out" | grep -q "CHECK api_health fail.*no checks.database" \
  && ok "no-checks: api_health flags missing field" \
  || bad "no-checks: api_health line: $out"

# --- 4. /api/health 500 -> fail ----------------------------------------------
mock_up http500
out="$(run_checks)"; code=$?
[[ $code -eq 1 ]] && ok "http500: exit 1" || bad "http500: exit $code"
echo "$out" | grep -q "CHECK api_health fail" && ok "http500: api_health fail" \
  || bad "http500: api_health line: $out"

# --- 5. site down -> site checks fail ----------------------------------------
mock_down
out="$(SITE_URL="http://127.0.0.1:$PORT" API_URL="http://127.0.0.1:1" \
  HEALTH_CHECK_CI=false bash "$ROOT/infra/health/checks.sh")"; code=$?
[[ $code -eq 1 ]] && ok "site-down: exit 1" || bad "site-down: exit $code"
echo "$out" | grep -q "CHECK site_root fail" && ok "site-down: site_root fail" \
  || bad "site-down: site_root line: $out"

# --- 6. CI check parsing with a fake gh --------------------------------------
fakebin="$(mktemp -d)"
cat > "$fakebin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$FAKE_GH_JSON"
EOF
chmod +x "$fakebin/gh"
ci() { # ci <json> -> checks.sh api+site skipped? no: full run, mock healthy
  mock_up healthy
  PATH="$fakebin:$PATH" FAKE_GH_JSON="$1" \
    SITE_URL="http://127.0.0.1:$PORT" API_URL="http://127.0.0.1:$PORT" \
    HEALTH_CHECK_CI=true bash "$ROOT/infra/health/checks.sh" \
    | grep "CHECK main_ci"
}
line="$(ci '[{"status":"completed","conclusion":"success"}]')"
echo "$line" | grep -q "ok" && ok "ci: completed/success -> ok" \
  || bad "ci: completed/success: $line"
line="$(ci '[{"status":"completed","conclusion":"failure"}]')"
echo "$line" | grep -q "fail" && ok "ci: completed/failure -> fail" \
  || bad "ci: completed/failure: $line"
line="$(ci '[{"status":"in_progress","conclusion":null}]')"
echo "$line" | grep -q "ok" && ok "ci: in_progress -> ok (no false alert)" \
  || bad "ci: in_progress: $line"
line="$(ci '[]')"
echo "$line" | grep -q "fail" && ok "ci: empty run list -> fail" \
  || bad "ci: empty: $line"
rm -rf "$fakebin"
mock_down

# --- 7. alert.sh: one alert per incident, one all-clear, dedupe -------------
STATE="$(mktemp -d)/state.json"
alert() { # alert <lines...> -> alert.sh output
  printf '%s\n' "$@" | HEALTH_STATE_FILE="$STATE" bash "$ROOT/infra/health/alert.sh"
}
out="$(alert "CHECK api_health fail HTTP 500 (expected 200)")"
[[ "$out" == "ALERT: api_health failing: HTTP 500 (expected 200)" ]] \
  && ok "alert: first failure -> ALERT" || bad "alert first: '$out'"
out="$(alert "CHECK api_health fail HTTP 500 (expected 200)")"
[[ -z "$out" ]] && ok "alert: repeat failure -> silent" \
  || bad "alert repeat (spam): '$out'"
out="$(alert "CHECK api_health fail different detail")"
[[ -z "$out" ]] && ok "alert: failure with new detail -> still silent" \
  || bad "alert new detail (spam): '$out'"
out="$(alert "CHECK api_health ok status=ok database=ok")"
[[ "$out" == "RECOVERED: api_health" ]] \
  && ok "alert: recovery -> RECOVERED" || bad "alert recovery: '$out'"
out="$(alert "CHECK api_health ok status=ok database=ok")"
[[ -z "$out" ]] && ok "alert: steady ok -> silent" \
  || bad "alert steady ok: '$out'"
out="$(alert "CHECK api_health fail HTTP 500 (expected 200)")"
[[ "$out" == ALERT:* ]] && ok "alert: new incident -> ALERT again" \
  || bad "alert new incident: '$out'"
# second check name is independent
out="$(alert "CHECK site_root fail HTTP 0 (expected 200)" "CHECK api_health ok x")"
echo "$out" | grep -q "ALERT: site_root failing" \
  && ok "alert: per-check incidents independent" \
  || bad "alert independence: '$out'"
rm -rf "$(dirname "$STATE")"

# --- summary ------------------------------------------------------------------
echo "---"
echo "passed: $pass  failed: $fail"
[[ $fail -eq 0 ]]
