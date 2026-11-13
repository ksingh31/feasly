# Agent pipeline — runbook

Feasly runs an automated agent team on GitHub Actions. Agents are the role
files in `.claude/agents/`; workflows in `.github/workflows/agent-*.yml` start
them on GitHub events. Deterministic scripts in `tools/agents/` make every
queue/merge decision — the models only do the work and give verdicts.

## The loop

```
issue labelled agent:ready ──► Dispatch (script) ──► Dev agent ──► PR (agent:pr)
                                   ▲                                   │
                                   │                         Review agent (every push)
                                   │                   APPROVE │        │ REQUEST_CHANGES
                                   │              merge gate ▼        ▼
                                   │      auto-merge (waits for     Fix agent (≤3 rounds,
                                   │      build + lighthouse)        then needs:karan)
                                   │               │
                                   │          CD deploys dev
                                   │               │
                                   └── bug + agent:ready ◄── QA agent (Playwright on dev)

Architect (06:00 + 18:00 Calgary): watchdog script → re-plan / groom → digest issue
Ops (04:00 Calgary): read-only Azure health, timers, cost, Bicep drift → ops issues
```

| Workflow | Trigger | Agent / model | Writes |
|---|---|---|---|
| `agent-dispatch.yml` | `agent:ready` label, PR closed, hourly | script | claims issues, starts Dev |
| `agent-dev.yml` | dispatcher | frontend-dev / backend-dev / devops · Opus | branch `agent/issue-<n>-…`, PR |
| `agent-review.yml` | PR opened/updated (trusted authors) | pr-reviewer · Opus | inline comments, verdict, auto-merge via `merge-gate.mjs` |
| `agent-fix.yml` | review REQUEST_CHANGES, CI red > 12h | dev role · Opus | commits on the PR branch |
| `agent-qa.yml` | CD success on main | qa-tester · Sonnet + Playwright MCP | `qa:passed` / reopen + `qa:failed`, new bugs |
| `agent-architect.yml` | 13:00 + 01:00 UTC | watchdog script + architect · Fable | requeues, splits, digest issue |
| `agent-ci-triage.yml` | any failed CI / Lighthouse run | script | stale PR → update/`@dependabot rebase`; agent/Dependabot PR → fix round; main → "main is red" issue |
| `agent-ops.yml` | 11:00 UTC | devops + sre · Opus, Azure OIDC read-only | `ops` issues, digest comment |

## Labels

`agent:ready` (queue — **only add to issues you have read**), `agent:claimed`,
`agent:pr`, `needs:karan` (agents never touch it), `area:web|api|infra`
(routes to the right dev agent), `size:S|M|L` (1/3/5-day budget the watchdog
measures against), `priority:high`, `bug`, `qa:passed`, `qa:failed`, `ux`,
`ops`, `agent:digest`.

## Guardrails

- **Merge only when every check is green** (owner rule 2026-11-13), not just the required ones; flaky environment checks are re-run, never ignored.
- **Agents never merge their own work.** `merge-gate.mjs` (run from `main`,
  not from the PR) enables GitHub auto-merge only on an APPROVE verdict, and
  GitHub merges only when the required checks (`build`, `lighthouse`) are green.
- **Owner-gated paths** hold auto-merge and add `needs:karan`: `infra/bicep`,
  `.github/workflows`, `tools/agents`, `.claude/`, `CLAUDE.md`, DB migrations,
  `docs/legal`, `packages/cost-engine`, billing/Stripe code, `config/builders`.
  (The Claude GitHub App cannot push workflow files at all.)
- **Required checks**: `build`, `lighthouse`, `dependency-audit`, `secrets-scan` (branch protection, strict). Environment checks (`backup-config`, `community-stats-freshness`, `preview (SWA)`) depend on live Azure and never block a PR; on main they become `ops` issues.
- **WIP cap**: `AGENT_MAX_WIP` (default 2) claimed issues + open agent PRs.
- **Verify before push**: every agent runs `bash tools/verify-local.sh` and pushes only on `VERIFY: PASS`.
- **Fix until merged**: any failed CI run on an agent/Dependabot PR triggers a fix round (CI triage); each round
  reproduces locally, verifies, pushes. `AGENT_MAX_FIX_ROUNDS` (default 5), then `needs:karan`.
- **Requeues**: a claimed issue with no PR for 4h is requeued; after 2 requeues → `needs:karan`.
- **QA reopen cap**: a bug that fails QA twice goes to `needs:karan`.
- **Trust**: reviews run only for PRs from collaborators, `claude[bot]`,
  `dependabot[bot]`; the dispatcher only starts issues written by
  collaborators or the agents themselves. This repo is public — the issue/PR
  text is the agent's prompt.
- **Azure**: the ops agent's tools are limited to `az … show/list/query`,
  budgets and `what-if`. Nothing changes Azure without Karan.

## Backlog release

Approved design stories carry `backlog` (not `agent:ready`). On every run the dispatcher checks
the bug queue: when no open `bug` issue remains (except ones parked on `needs:karan`), it moves
every `backlog` story to `agent:ready`, and agents take them in `Order:` / `Blocked by` sequence.

## Kill switch

Set repo variable `AGENTS_ENABLED` to anything other than `true` (or delete
it). Every agent workflow checks it first.

## One-time setup (owner)

1. Install the **Claude GitHub App** on `ksingh31/feasly`
   (https://github.com/apps/claude). Its token is what makes agent pushes and
   merges trigger CI/CD.
2. Add a secret **`CLAUDE_CODE_OAUTH_TOKEN`** (run `claude setup-token` locally)
   — or `ANTHROPIC_API_KEY` for pay-per-use — under Settings → Secrets → Actions,
   **and** the same under Secrets → Dependabot so Dependabot PRs get reviewed.
3. Repo variables: `AGENTS_ENABLED=true`; optional `AGENT_MAX_WIP`,
   `AGENT_MAX_FIX_ROUNDS`, `AGENT_CLAIM_STALL_HOURS`, `AGENT_PR_STALE_HOURS`,
   `AGENT_CI_RED_HOURS`. (`AZURE_*` variables already exist for CD.)
4. Repo setting "Allow auto-merge" — enabled 2026-11-13.

## Operating it

- Queue work: write an issue with acceptance criteria, add `area:*`, `size:*`, then `agent:ready`.
- Watch: the pinned **Agent digest** issue (`agent:digest`), updated every morning.
- Run anything by hand: Actions → the workflow → Run workflow.
- Local dry-runs: `node tools/agents/dispatch.mjs --dry-run`,
  `node tools/agents/watchdog.mjs --dry-run`, `node tools/agents/merge-gate.mjs <pr> APPROVE --dry-run`.
- Tests: `node --test tools/agents/*.test.mjs` (also in CI).
