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
| `agent-merge.yml` | every 10 min + when CI/Lighthouse/CD/Review finish | script | merges approved PRs only when **every** check is green; updates one stale branch per run; re-runs red env checks (≤3); then dispatches CI + dev deploy on main |
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
  reproduces locally, verifies, pushes. `AGENT_MAX_FIX_ROUNDS` (default 5), then the PR is **parked as
  `agent:stuck`** for the orchestrator (not `needs:karan` — repeated failures are not an owner decision; a
  `needs:karan` already on the PR for a real owner question is kept). Fix-round cap rules (#924), all in
  `tools/agents/lib.mjs` (`fixRoundState` / `planFixRound`) and `tools/agents/fix-round.mjs`:
  - The parked comment (`<!-- agent:fix-cap -->`) is posted **once**; later dispatches exit silently.
  - Every dispatch site (merger conflict branch, merge gate, review follow-up, watchdog, CI triage) skips a
    parked PR, so no agent-fix run starts for it. The watchdog lists parked PRs in `summary.parked`
    (reason `parked at fix-round cap`, judged regardless of `updatedAt`) and adds `agent:stuck` if missing.
  - Merge-conflict rounds (reason starts with `merge conflict with main`) have their own counter and never
    count toward the cap.
  - Pre-#924 "Fix-round cap (N) reached — parked for Karan." comments still count as parked.
  - **Release** a parked PR (after fixing the cause or deciding it deserves more rounds): comment
    `<!-- agent:fix-cap-reset -->` on it and remove `agent:stuck`; only rounds after that comment count.
  - Fix-round, cap and reset markers only count when the comment's author is trusted (OWNER / MEMBER /
    COLLABORATOR, or the `claude` / `github-actions` bots), so an outside commenter can't re-arm the budget
    or park a PR. Comments are read via the paginated REST API (`gh.mjs prComments`), not the 100-capped
    `gh pr list --json comments`.
  A round that merges `main` must regenerate the registry-derived route tables (`npm run gen:route-docs`:
  TECH_PLAN §16 + `docs/security/rate-limits.md` + `docs/security/route-audit.md`) and commit the result. `verify-local.sh` runs it before
  the tests, so a parallel route-adding merge no longer leaves the PR red (#816).
  It must also run `node tools/renumber-migrations.mjs` (`verify-local.sh` runs it before the typecheck): when
  main gained a migration with the same number as this branch's, it renames ours to the next free number and
  rebuilds `_journal.json` as main's entries + ours appended, which resolves the journal conflict (#900).
  Commit the files it stages. Repair-SQL additions go in `apps/api/tools/repair-sql.d/` so they never conflict.
- **Requeues**: a claimed issue with no PR for 4h, or a dev run that ends without a PR, is requeued; after 2 requeues → `agent:stuck` (the orchestrator investigates; not an owner decision). A claimed issue whose PR already merged (closing reference or `agent/issue-<n>-` branch, merged since the claim) is closed as completed instead of requeued.
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

## Supervision (every 10 minutes while agents are active)
Owner rule (2026-11-13). Whoever operates the pipeline (release-manager, or the interactive session) checks
agent runs (`agent-dev.yml`, `agent-fix.yml`) and claimed issues every 10 minutes and acts without waiting:
- **Failed run** → requeue its issue now (remove `agent:claimed`, add `agent:ready`, comment `<!-- agent:requeue -->` + reason) and read the failure log.
- **Claimed ≥ 15 min with no running agent and no PR** → first check for a *merged* PR that closes it (`gh pr list --state merged --search "<n>"`); if there is one, close the issue as completed and drop `agent:claimed`. Otherwise requeue (orphaned claim).
- **Ready work but 0 agents running** → `gh workflow run agent-dispatch.yml`.
- **Run in progress ≥ 50 min** (normal: 15–40 min incl. verify-local) → read its log and step in.
- **Same issue requeued 3+ times** → fix it directly or park with `needs:karan` and the reason.
- **Merges**: only when *every* check is green and the reviewer verdict is APPROVE; re-run flaky environment checks, update branches one at a time.
- **QA issues that contradict an owner decision** (CLAUDE.md "Owner decisions") → close citing the decision.

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
