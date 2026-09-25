#!/usr/bin/env bash
# alert.sh — incident-aware notifier for the repo-owned health checks (HRD-06).
#
# Usage:  infra/health/checks.sh | infra/health/alert.sh
#
# Reads `CHECK <name> <ok|fail> <detail>` lines from stdin and keeps
# per-check incident state in a JSON state file:
#   - ok -> fail   : prints  ALERT: <name> failing: <detail>      (one per incident)
#   - fail -> ok   : prints  RECOVERED: <name>                     (exactly one all-clear)
#   - fail -> fail : silent (dedupe — no repeated spam)
#   - ok   -> ok   : silent
#
# Env:
#   HEALTH_STATE_FILE   default: ./health-watch-state.json next to the cron's
#                       workspace root (overridable for tests).
#
# Delivery: printed ALERT/RECOVERED lines are surfaced by the cron to the
# side chat. The email leg is a forward-compatible hook: when
# admin/06-admin-ops-alerts lands, its alert service becomes the delivery
# channel — replace the `deliver()` body. (Until then, nothing here sends
# email; the notifier is side-chat-only per the no-real-emails rule.)
set -uo pipefail

STATE_FILE="${HEALTH_STATE_FILE:-$HOME/workspace/feasly/health-watch-state.json}"

# --- delivery hook (see header) ---------------------------------------------
deliver() { # deliver <line>
  echo "$1"
}

# --- state -------------------------------------------------------------------
load_state() {
  if [[ -f "$STATE_FILE" ]]; then
    cat "$STATE_FILE"
  else
    echo '{"checks":{}}'
  fi
}

prev_state_of() { # prev_state_of <json> <name> -> ok|fail (unknown counts as ok)
  local state
  state="$(echo "$1" | jq -r --arg n "$2" '.checks[$n].state // "ok"')"
  echo "$state"
}

save_state() { # save_state <json> <name> <state> <detail>
  local json="$1" name="$2" state="$3" detail="$4"
  echo "$json" | jq --arg n "$name" --arg s "$state" --arg d "$detail" \
    '.checks[$n] = {state: $s, detail: $d, updated: (now | todate)}'
}

mkdir -p "$(dirname "$STATE_FILE")"
state="$(load_state)"

while IFS= read -r line; do
  [[ "$line" =~ ^CHECK\ ([^[:space:]]+)\ ([^[:space:]]+)\ (.*)$ ]] || continue
  name="${BASH_REMATCH[1]}"
  status="${BASH_REMATCH[2]}"
  detail="${BASH_REMATCH[3]}"
  prev="$(prev_state_of "$state" "$name")"

  if [[ "$status" == "fail" && "$prev" != "fail" ]]; then
    deliver "ALERT: ${name} failing: ${detail}"
  elif [[ "$status" == "ok" && "$prev" == "fail" ]]; then
    deliver "RECOVERED: ${name}"
  fi
  state="$(save_state "$state" "$name" "$status" "$detail")"
done

# Atomic write so a killed run never leaves a half-written state file.
tmp="$(mktemp "$(dirname "$STATE_FILE")/.health-state.XXXXXX")"
echo "$state" > "$tmp"
mv "$tmp" "$STATE_FILE"
