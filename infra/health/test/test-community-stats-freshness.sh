#!/usr/bin/env bash
# test-community-stats-freshness.sh — unit tests for
# infra/health/check-community-stats-freshness.sh (#951 runner reachability).
# No Azure, no network, no Postgres: `az`, `psql`, `curl` and `sleep` are
# stubs on PATH. The psql stub only "connects" while a firewall rule exists
# (or when REACHABLE=1), mimicking a runner the AllowAzureServices rule
# does not cover.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$ROOT/infra/health/check-community-stats-freshness.sh"

pass=0
fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
bad() { fail=$((fail + 1)); echo "FAIL - $1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"

cat >"$BIN/psql" <<'EOF'
#!/usr/bin/env bash
if [[ "${REACHABLE:-0}" != 1 ]] && ! ls "$STATE"/rule-* >/dev/null 2>&1; then
  echo "psql: error: connection to server failed: Connection timed out" >&2
  exit 2
fi
sql="${*: -1}"
case "$sql" in
  "SELECT 1;") echo 1 ;;
  *"refreshed_at < now()"*) echo "${STALE_RESULT:-0|}" ;;
  *"SELECT count(*) FROM community_stats;"*) echo 98 ;;
esac
EOF

cat >"$BIN/az" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$STATE/az.log"
rule=""; server=""; prev=""
for a in "$@"; do
  case "$prev" in
    --name|-n) rule="$a" ;;
    --server-name|-s) server="$a" ;;
  esac
  prev="$a"
done
# Mirror the real CLI (azure-cli 2.92): firewall-rule takes --server-name/-s
# for the server and --name/-n for the rule; --rule-name does not exist (#959).
if [[ "$*" == *"firewall-rule"* ]]; then
  if [[ " $* " == *" --rule-name "* ]]; then
    echo "az: error: unrecognized arguments: --rule-name" >&2; exit 2
  fi
  if [[ -z "$server" ]]; then
    echo "az: error: the following arguments are required: --server-name/-s" >&2; exit 2
  fi
  if [[ "$*" != *"firewall-rule list"* && -z "$rule" ]]; then
    echo "az: error: stub requires --name/-n for the rule" >&2; exit 2
  fi
fi
case "$*" in
  *"firewall-rule create"*)
    [[ "${AZ_CREATE_FAILS:-0}" == 1 ]] && exit 1
    touch "$STATE/rule-$rule" ;;
  *"firewall-rule delete"*) rm -f "$STATE/rule-$rule" ;;
  *"firewall-rule list"*)
    printf '%s\n' AllowAzureServices ${EXTRA_RULES:-}
    for f in "$STATE"/rule-*; do [[ -e "$f" ]] && echo "${f##*/rule-}"; done ;;
esac
exit 0
EOF

printf '#!/usr/bin/env bash\necho 203.0.113.7\n' >"$BIN/curl"
printf '#!/usr/bin/env bash\nexit 0\n' >"$BIN/sleep"
chmod +x "$BIN"/*

# run <name> [VAR=val ...] — runs the script with a fresh state dir.
run() {
  STATE="$WORK/$1"; shift
  mkdir -p "$STATE"; : >"$STATE/az.log"
  OUT="$(env -i PATH="$BIN:$PATH" HOME="$HOME" STATE="$STATE" \
    PGHOST=feasly-dev-pg-test.postgres.database.azure.com PGPASSWORD=x \
    PG_RESOURCE_GROUP=rg-test "$@" bash "$SCRIPT" 2>&1)"
  RC=$?
}

# 1. Reachable runner: no firewall calls at all.
run direct GITHUB_ACTIONS=true REACHABLE=1
[[ $RC -eq 0 && "$OUT" == *"OK: community_stats fresh (98 rows"* ]] \
  && ok "reachable runner: passes" || bad "reachable runner: rc=$RC out=$OUT"
grep -q firewall-rule "$STATE/az.log" \
  && bad "reachable runner: touched the firewall" || ok "reachable runner: firewall untouched"

# 2. Unreachable runner in CI: temp /32 rule for the runner IP, then removed.
run blocked GITHUB_ACTIONS=true GITHUB_RUN_ID=42 GITHUB_RUN_ATTEMPT=1
[[ $RC -eq 0 && "$OUT" == *"OK: community_stats fresh"* ]] \
  && ok "blocked runner: passes via temporary rule" || bad "blocked runner: rc=$RC out=$OUT"
grep -Eq 'firewall-rule create -g rg-test --server-name feasly-dev-pg-test --name ci-freshness-[0-9]+-42-1 --start-ip-address 203.0.113.7 --end-ip-address 203.0.113.7' "$STATE/az.log" \
  && ok "blocked runner: rule is /32 for the runner IP on the right server" \
  || bad "blocked runner: unexpected create call: $(cat "$STATE/az.log")"
ls "$STATE"/rule-* >/dev/null 2>&1 \
  && bad "blocked runner: temporary rule left behind" || ok "blocked runner: temporary rule removed on exit"

# 3. Stale data still fails (check not weakened) and the rule is still removed.
run stale GITHUB_ACTIONS=true STALE_RESULT="3|2026-01-01 00:00:00+00"
[[ $RC -eq 1 && "$OUT" == *"3 community_stats row(s) have refreshed_at older than 45 days"* ]] \
  && ok "stale data: still fails" || bad "stale data: rc=$RC out=$OUT"
ls "$STATE"/rule-* >/dev/null 2>&1 \
  && bad "stale data: temporary rule left behind" || ok "stale data: temporary rule removed on failure"

# 4. Opt-out: PG_TEMP_FIREWALL=0 never creates a rule and fails loudly.
run optout GITHUB_ACTIONS=true PG_TEMP_FIREWALL=0
[[ $RC -eq 1 && "$OUT" == *"FAIL: could not query community_stats"* ]] \
  && ok "opt-out: fails on unreachable server" || bad "opt-out: rc=$RC out=$OUT"
grep -q "firewall-rule create" "$STATE/az.log" \
  && bad "opt-out: created a rule" || ok "opt-out: no rule created"

# 5. Outside CI (auto mode): no rule is created.
run local
grep -q "firewall-rule create" "$STATE/az.log" \
  && bad "local auto mode: created a rule" || ok "local auto mode: no rule created"
[[ $RC -eq 1 ]] && ok "local auto mode: fails on unreachable server" || bad "local auto mode: rc=$RC"

# 6. Create denied (no RBAC): fails with the real error, no crash.
run denied GITHUB_ACTIONS=true AZ_CREATE_FAILS=1
[[ $RC -eq 1 && "$OUT" == *"could not create temporary firewall rule"* && "$OUT" == *"FAIL: could not query"* ]] \
  && ok "create denied: fails loudly" || bad "create denied: rc=$RC out=$OUT"

# 6b. Every firewall call uses --server-name/--name, never -n <server> --rule-name (#959).
run flags GITHUB_ACTIONS=true EXTRA_RULES="ci-freshness-1-1-1"
grep -q -- "--rule-name" "$STATE/az.log" \
  && bad "flags: used nonexistent --rule-name" || ok "flags: no --rule-name"
[[ "$(grep -c firewall-rule "$STATE/az.log")" -ge 3 ]] \
  && ! grep firewall-rule "$STATE/az.log" | grep -vq -- "--server-name feasly-dev-pg-test" \
  && ok "flags: create/delete/list all pass --server-name" \
  || bad "flags: a firewall call lacks --server-name: $(cat "$STATE/az.log")"

# 7. Sweep: rules from killed jobs older than an hour go; recent ones stay.
OLD="ci-freshness-$(( $(date +%s) - 7200 ))-1-1"
RECENT="ci-freshness-$(( $(date +%s) - 60 ))-2-1"
run sweep GITHUB_ACTIONS=true EXTRA_RULES="$OLD $RECENT"
grep -q -- "delete .*--name $OLD" "$STATE/az.log" \
  && ok "sweep: deletes a stale ci-freshness rule" || bad "sweep: stale rule kept: $(cat "$STATE/az.log")"
grep -q -- "--name $RECENT" "$STATE/az.log" \
  && bad "sweep: deleted a recent rule (another job's)" || ok "sweep: keeps recent rules"
grep -q -- "--name AllowAzureServices" "$STATE/az.log" \
  && bad "sweep: touched AllowAzureServices" || ok "sweep: never touches AllowAzureServices"

echo
echo "community-stats-freshness tests: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
