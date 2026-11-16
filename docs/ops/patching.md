# Dependency and patch policy (HRD-017)

How Feasly keeps its dependencies patched. Owner: Karan (merges); agents and
`release-manager` do the triage.

## What runs

| Mechanism | What it does | Where |
|---|---|---|
| Dependabot version updates | Weekly PRs (Monday 09:00 America/Edmonton) for npm (root + workspaces) and GitHub Actions | `.github/dependabot.yml` |
| Dependabot alerts + security updates | Opens a PR as soon as an advisory affects a dependency, outside the weekly schedule | Repo **Settings → Code security** (repo-admin toggle) |
| `dependency-audit` CI check (required) | `npm audit --audit-level=high` on root, API and web workspaces; a high/critical advisory fails every PR | `.github/workflows/ci.yml` |

## Patch SLA

Clock starts when the advisory is published to us (Dependabot alert, or the
`dependency-audit` check going red), not when someone notices it.

| Severity (GitHub advisory / CVSS) | Patched on `main` and deployed to dev within | Notes |
|---|---|---|
| Critical | **48 hours** | Drop story work. If no fixed version exists, remove or mitigate the vulnerable path and record the mitigation on the issue. |
| High | **7 days** | `dependency-audit` blocks merges until fixed, so in practice same day. |
| Moderate | **30 days** | Usually rides the weekly Dependabot batch. |
| Low | Next routine update | Batched; no separate issue needed. |

A runtime dependency (shipped in `apps/api` or `apps/web` bundles) counts at
its advisory severity. A dev-only dependency (build, test, lint tooling) may
drop one level if the vulnerable code never runs in CI against untrusted
input; write the reason on the PR.

## Handling an advisory

1. Merge the Dependabot security PR once every check is green (CLAUDE.md
   merge rule). If it does not exist or fails, open `fix/deps-<package>`
   and bump by hand (`npm update <pkg>` or an `overrides` entry).
2. If no patched version exists: file a `bug` issue with the advisory link,
   the affected path, and the mitigation; set a review date. Do not dismiss
   the alert without that issue.
3. Confirm CD deployed the fix to dev ("merged" is not "live").

## Quarterly review

Each quarter, check the major versions of the Azure SDKs, Angular, Node, the
Postmark, Stripe and Meta SDKs, and Drizzle against their support windows,
and file a `chore` issue for anything within 3 months of end of support.
