#!/usr/bin/env bash
# Keep a free SWA preview slot (Free plan: 3 staging environments).
#  1. delete previews whose PR is not open (merged/closed — GITHUB_TOKEN merges never fire
#     the pull_request:closed event that would have closed them)
#  2. if still full and MAKE_ROOM_FOR is set, evict the preview of the least recently
#     updated *other* open PR (it is rebuilt on that PR's next push)
# Needs: az (logged in, Contributor on the RG), gh (GH_TOKEN), SWA_NAME, SWA_RG.
set -uo pipefail
SWA_NAME=${SWA_NAME:-feasly-dev-web-4fhkep}; SWA_RG=${SWA_RG:-rg-feasly-dev}; MAX=${MAX_PREVIEWS:-3}
envs() { az staticwebapp environment list -n "$SWA_NAME" -g "$SWA_RG" --query "[?name!='default'].name" -o tsv; }
del() { echo "deleting preview env $1 ($2)"; az staticwebapp environment delete -n "$SWA_NAME" -g "$SWA_RG" --environment-name "$1" --yes >/dev/null || echo "::warning::could not delete env $1"; }
for e in $(envs); do
  st=$(gh pr view "$e" --json state -q .state 2>/dev/null || echo UNKNOWN)
  [ "$st" != "OPEN" ] && del "$e" "PR $st"
done
if [ -n "${MAKE_ROOM_FOR:-}" ]; then
  mapfile -t cur < <(envs)
  if [ "${#cur[@]}" -ge "$MAX" ] && ! printf '%s\n' "${cur[@]}" | grep -qx "$MAKE_ROOM_FOR"; then
    victim=$(for e in "${cur[@]}"; do printf '%s %s\n' "$(gh pr view "$e" --json updatedAt -q .updatedAt)" "$e"; done | sort | head -1 | awk '{print $2}')
    [ -n "$victim" ] && del "$victim" "least recently updated open PR — evicted for #$MAKE_ROOM_FOR"
  fi
fi
# Azure deletes asynchronously: wait (≤3 min) until a slot is really free.
if [ -n "${MAKE_ROOM_FOR:-}" ]; then
  for _ in $(seq 1 18); do
    n=$(envs | grep -vx "$MAKE_ROOM_FOR" | wc -l | tr -d ' ')
    [ "$n" -lt "$MAX" ] && break
    echo "waiting for Azure to release a slot ($n/$MAX in use)…"; sleep 10
  done
fi
echo "preview envs now: $(envs | tr '\n' ' ')"
