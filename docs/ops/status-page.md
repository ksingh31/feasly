# Public status page (#831)

Owner decision (2026-11-15): a free, GitHub-hosted status page. We use
[Upptime](https://upptime.js.org) — GitHub Actions run the checks, GitHub
Pages serves the page, GitHub Issues record incidents.

**Cost: CA$0, no Azure resources.** Actions minutes and Pages are free on a
public repo. The checks are plain HTTP GETs against the existing dev site and
API (read-only, same endpoints as `infra/health/checks.sh`), so they add no
billable Azure work beyond 3 requests every 5 minutes on resources that are
already free/consumption.

## What is monitored

| Name | URL | Down when | Degraded when |
|---|---|---|---|
| Site | `{SITE_URL}/` | not HTTP 2xx | slow response |
| API | `{API_URL}/api/health` | not HTTP 2xx | body says `degraded` (DB unreachable — `/api/health` never 500s for a sick DB) |
| Embed | `{SITE_URL}/embed/v1/loader.js` | not 2xx, or the body lacks the `Feasly embed loader` banner (e.g. the SWA fell back to `index.html`) | slow response |

Every 5 minutes (`workflowSchedule.uptime`). URLs match the defaults in
`infra/health/checks.sh`; `apps/web/tools/status-page-config.spec.ts` fails CI
if they drift or the 5-minute cadence, assignees or Pages path change.

## Where things live

| What | Where |
|---|---|
| Config (source of truth) | `infra/status-page/.upptimerc.yml` in **this** repo |
| Running copy | `.upptimerc.yml` at the root of the public repo `ksingh31/feasly-status` |
| Status page | `https://ksingh31.github.io/feasly-status/` |
| Incidents | Issues in `ksingh31/feasly-status`, opened on the first failed check, assigned per `assignees`, closed automatically on recovery |
| Footer link | `site.statusPageUrl` in `apps/web/public/assets/config/app-config.json` — the footer shows **Status** only when it's set |

## One-time setup (owner — needs GitHub account access)

The app token our agents use can't create repos under the owner's account, so
these steps are manual, about 10 minutes:

1. Create the repo from the template: <https://github.com/upptime/upptime/generate>
   → owner `ksingh31`, name `feasly-status`, **Public**, include all branches: off.
2. Replace its `.upptimerc.yml` with `infra/status-page/.upptimerc.yml` from
   this repo, then commit.
3. Settings → Actions → General → Workflow permissions: **Read and write**.
4. Add the repo secret `GH_PAT`: a fine-grained personal access token scoped
   to `feasly-status` only, with Actions, Contents, Issues and Workflows
   read/write (Upptime's documented minimum). It stays in that repo's secrets
   — never in this repo, Key Vault isn't involved.
5. Actions tab → enable workflows → run **Setup CI** once. It builds the site
   and pushes `gh-pages`.
6. Settings → Pages → Source: branch `gh-pages`, `/ (root)`.
7. Check `https://ksingh31.github.io/feasly-status/` shows Site, API and Embed.
8. Turn on the footer link: PR setting `site.statusPageUrl` to
   `https://ksingh31.github.io/feasly-status/` in `app-config.json`. The spec
   checks it matches the Upptime config.

## Changing checks

Edit `infra/status-page/.upptimerc.yml` here (PR, CI runs the spec), then copy
it to `feasly-status`. When the production domain lands (`apps/web/SEO.md`),
update `infra/health/checks.sh` and this file together.

## Relation to the health watch

`infra/health/` (see `health-monitoring.md`) is the internal 30-minute watch
that also checks main CI and alerts the team. Upptime is the **public**
view: uptime history and incident issues anyone can see. They're independent,
so if one breaks the other still runs.
