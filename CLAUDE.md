# Feasly — project instructions for Claude Code

> This file is the Feasly brief. It overrides any parent-directory CLAUDE.md
> (e.g. an unrelated "Capital Catalyst" brief) for work inside this repo.

Feasly is a deterministic infill build-cost estimator for Calgary: a homeowner
enters an address, gets City-assessed property data plus land/build/total cost
ranges from one pure-TS cost engine. Launches as a white-label builder embed
(pilot: Elite Craft Builders), with an agent API + MCP server on the same engine.

## Read before writing code (in this order)
1. `docs/plan/CODING_PATTERNS.md` — the law.
2. `docs/epics-ui/README.md` and `docs/epics-api/README.md` — non-negotiables + DoD.
3. `docs/adr/ADR-001-architecture.md`, `docs/plan/TECH_PLAN.md` — architecture.
4. `apps/web/ARCHITECTURE.md` for frontend work.
Repo docs + dated owner decisions win over anything else.

## Stack
Angular 22 (standalone, signals, NGXS + storage plugin) · Azure Functions (TS,
Node 22, Flex Consumption) · Postgres 16 + Drizzle · `packages/cost-engine`
(pure, zero I/O, never imported by `apps/web`) · `packages/contracts` (DTOs + zod)
· `packages/mcp` · Bicep (`infra/bicep`) · GitHub Actions (`ci.yml`, `cd.yml`,
`lighthouse.yml`, `db-repair.yml`) · Vitest.

## Verify locally (what CI runs) — Node 22
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm ci && npm run build:configs --workspace @feasly/api
npx tsc -b                                   # canonical typecheck, from root only
npm run test --workspaces --if-present
npm run lint --workspaces --if-present
npm run build --workspace=@feasly/web -- --configuration=production
node tools/check-placeholders.mjs && node apps/web/tools/check-banned-phrases.mjs && node apps/web/tools/check-casl-copy.mjs
```
Never run bare `tsc`/`tsc -b` inside `apps/web` (emits .js next to .ts). Web
typecheck: `npx tsc -p tsconfig.app.json --noEmit`. Web tests: `--include='**/*.spec.ts'`.

## Traps (each cost the previous team real time)
- New API endpoint = `function.json` + `apps/api/src/registry/route-registry.ts` + `apps/api/tools/bundle-functions.mjs`, same commit.
- New DB column/table → update `apps/api/tools/repair-sql.mjs` (schema-repair coverage test).
- New config property → update full-object expectations in `apps/api/test/config.test.ts`.
- Migrations: expand → migrate → contract. Never NOT NULL without default in one step.
- `git fetch` and check `origin/main` before calling code missing or a bug real.
- No fixed sleeps in async tests — poll for a terminal state with a deadline.
- SWA preview cap is 3; stale merged-PR previews block new ones.

## Hard rules
- Every dollar figure comes from `packages/cost-engine`. LLM writes narrative only.
- No hardcoded values (web: ConfigService; api: `config.ts`). Routes never import `db/`.
- `takeUntilDestroyed()` on every subscribe; no orphaned timers.
- Copy: "Unlock" appears exactly once; no accuracy claims; never "guarantee",
  "appraisal", "market value" outside approved disclaimers.
- Secrets only in Key Vault; never in code, params, logs, or PR text.

## Process
- Branch `feat/<story-id>-<slug>` (or `fix/…`, `chore/…`) → PR → all CI green → merge (squash).
- Bug found → log it as a GitHub issue, fix before new story work.
- After each story: pattern review, AC audit, 2–3 sentence summary.
- UI work gets real-browser QA: desktop + 390×844 mobile, axe zero critical/serious.
- "Merged" is not "live": confirm CD is green and the change shows on dev.

## Azure — owner's standing rules
- Subscription `9b7d7805-311a-4e4f-ac48-5d281d7e1185`, RG `rg-feasly-dev`, Canada Central.
- **Free tier only.** Never upgrade a SKU/subscription or create paid resources
  without Karan's explicit approval for that specific change.
- Reads/diagnostics freely (`az`, Azure MCP in read-only mode, Log Analytics
  workspace `feasly-dev-law`). Infra changes go through Bicep PRs.
- Status 2026-11-13: subscription upgraded to **Pay-As-You-Go** (spending limit
  off). Budget `feasly-monthly-cap` = $100/mo. It was disabled 2026-10-24 →
  2026-11-13, so telemetry has a gap for those dates.

## Agent team (`.claude/agents/`)
| Agent | Model | Use for |
|---|---|---|
| `architect` | fable | Design, story breakdown, ADR changes, cross-cutting decisions |
| `frontend-dev` | opus | Angular/NGXS implementation in `apps/web` |
| `backend-dev` | opus | Functions, services, Drizzle, engine, contracts, MCP |
| `devops` | opus | Bicep, GitHub Actions, CD, Azure diagnostics |
| `pr-reviewer` | opus | Independent review of a PR against the law — read-only |
| `qa-tester` | sonnet | Test suites + Playwright browser E2E, mobile, a11y |
| `ux-reviewer` | sonnet | Visual/UX/copy review with screenshots |
| `sre-investigator` | sonnet | App Insights / Log Analytics / incident triage |
| `release-manager` | sonnet | CI watch, merge on green, Dependabot, post-deploy check |

Typical story flow: architect (plan) → frontend-dev / backend-dev (build on a
branch, open PR) → pr-reviewer + qa-tester (+ ux-reviewer for UI) in parallel →
fix rounds → release-manager merges on green and confirms dev deploy.

The same flow runs unattended on GitHub Actions (`.github/workflows/agent-*.yml`,
scripts in `tools/agents/`). Runbook, labels, guardrails and kill switch:
`docs/agents.md`. Dev agents branch as `agent/issue-<n>-<slug>`.
