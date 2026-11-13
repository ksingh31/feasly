#!/usr/bin/env bash
# Local mirror of CI's required `build` job (.github/workflows/ci.yml) plus
# the dependency-audit gate. Every agent and human runs this before pushing
# or opening a PR; a push is only allowed when it ends with "VERIFY: PASS".
#
#   bash tools/verify-local.sh            # full run (~6-10 min)
#   bash tools/verify-local.sh --no-ci    # skip `npm ci` (reuse node_modules)
#
# Runs EVERY step even after a failure so one run shows all problems, then
# exits non-zero if anything failed. Keep this list in sync with ci.yml.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ -d /opt/homebrew/opt/node@22/bin ]; then export PATH="/opt/homebrew/opt/node@22/bin:$PATH"; fi
# macOS: CI runs on Linux; the infra shell tests use GNU date/sed. Use GNU
# coreutils when available (brew install coreutils) so results match CI.
if [ "$(uname)" = "Darwin" ] && [ -d /opt/homebrew/opt/coreutils/libexec/gnubin ]; then
  export PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH"
fi
# Use a dedicated npm cache (a global ~/.npm with root-owned dirs breaks
# `npm ci`). Override by exporting npm_config_cache yourself.
export npm_config_cache="${npm_config_cache:-${TMPDIR:-/tmp}/feasly-npm-cache}"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" != "22" ]; then echo "verify-local: Node 22 required (found $(node -v))" >&2; exit 2; fi

failed=()
step() {
  local name="$1"; shift
  printf '\n=== %s\n' "$name"
  if "$@"; then echo "--- ok: $name"; else echo "--- FAIL: $name"; failed+=("$name"); fi
}

# CI starts from a clean checkout: no stale build output (some lint checks
# inspect apps/web/dist when it exists).
rm -rf apps/web/dist
[ "${1:-}" = "--no-ci" ] || step "npm ci" npm ci
step "dependency audit (high)" npm audit --audit-level=high
step "build:configs" npm run build:configs --workspace @feasly/api
step "tsc -b (root)" npx tsc -b
step "tests (all workspaces)" npm run test --workspaces --if-present
step "lint (all workspaces)" npm run lint --workspaces --if-present
step "secrets-gate self-test" node --test tools/check-secrets.test.mjs
if compgen -G "tools/agents/*.test.mjs" >/dev/null; then
  step "agent pipeline tests" node --test tools/agents/*.test.mjs
fi
step "web production build" npm run build --workspace=@feasly/web -- --configuration=production
step "prerender SEO check" bash -c 'cd apps/web && node tools/check-prerender-seo.mjs'
step "bundle secrets scan" node tools/check-secrets.mjs --bundle apps/web/dist/web/browser
step "health-check tests" bash infra/health/test/test-checks.sh
step "PITR drill tests" bash infra/health/test/test-pitr-drill.sh
step "backup bicep check" bash tools/check-backup-bicep.sh
step "CASL copy" node apps/web/tools/check-casl-copy.mjs
step "banned phrases" node apps/web/tools/check-banned-phrases.mjs
step "placeholders" node tools/check-placeholders.mjs

# Generated community data must not be committed by accident.
if ! git diff --quiet -- apps/web/src/content/data apps/web/prerender-routes.txt; then
  echo "note: the build regenerated community data (uncommitted). Commit it only in a deliberate data-refresh change."
fi

echo
if [ ${#failed[@]} -eq 0 ]; then
  echo "VERIFY: PASS"
else
  printf 'VERIFY: FAIL (%d)\n' "${#failed[@]}"; printf '  - %s\n' "${failed[@]}"
  exit 1
fi
