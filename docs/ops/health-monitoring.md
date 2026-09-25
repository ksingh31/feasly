# Health monitoring (HRD-06)

> The API in dev is **read-only safe to probe**: all checks below are plain
> HTTP GETs and a `SELECT 1`. Nothing is written, provisioned, or changed.

## What is monitored

| Check | Source | Healthy when |
|---|---|---|
| `site_root` | `GET {SITE_URL}/` | HTTP 200 |
| `site_privacy` | `GET {SITE_URL}/privacy` | HTTP 200 |
| `api_health` | `GET {API_URL}/api/health` | HTTP 200, `status: "ok"`, `checks.database: "ok"` |
| `main_ci` | `gh run list --branch main` | latest completed run succeeded (in-progress/queued never alert) |

Check definitions live in **`infra/health/checks.sh`** — the single source of
truth. The `feasly-health-watch` cron (every 30 min) fetches the script from
`origin/main` and runs it; there is no forked check logic anywhere else.

## Alerting (one alert per incident)

`infra/health/alert.sh` consumes the `CHECK …` lines and keeps per-check
incident state in `~/workspace/feasly/health-watch-state.json`:

- first failure → `ALERT: <name> failing: <detail>`
- recovery → `RECOVERED: <name>` (exactly one all-clear)
- continued failure → **silent** (no repeated spam)
- new failure after a recovery → `ALERT` again

The cron surfaces these lines to the side chat. **No email is sent by this
track** (standing rule). When `admin/06-admin-ops-alerts` lands, its alert
service becomes the delivery channel: replace the `deliver()` body in
`infra/health/alert.sh` — the transition logic stays untouched.

## The /api/health endpoint

`GET /api/health` (Azure Functions adapter in `apps/api/src/functions/health.ts`,
bundled to `health/index.js` by `npm run bundle:functions`) answers through the
real composition:

```json
{ "status": "ok", "service": "feasly-api", "version": "0.1.0",
  "checks": { "database": "ok" } }
```

- `database: "ok"` — the pg pool answered `SELECT 1` within the configured timeout.
- `database: "unreachable"` — pool sick or timeout; HTTP stays **200** with
  `"status": "degraded"` (never a 500 for a sick dependency).
- `database: "not-configured"` — no `dbPing` wired (only in tests).

**Socrata note:** the City of Calgary open-data calls happen in the Angular
frontend (`apps/web`), not the API, so there is no Socrata circuit-breaker on
the API to report. Frontend reachability is covered by the site checks above.

## Deploy window

After this story merges, CD deploys the new health function. Until the deploy
finishes, the cron's `api_health` check fails with "no checks.database field —
dependency health not reported" — that alert is real (the endpoint genuinely
doesn't report dependency health yet) and clears on the next run after deploy.

## Tests

`infra/health/test/` — mock-server tests, no network/Azure needed:

```bash
bash infra/health/test/test-checks.sh
```

Covers: healthy/degraded-db/missing-checks-field/500/site-down mocks, CI
status parsing (fake `gh`), and the alert dedupe lifecycle
(fail → ALERT, fail → silent, recover → RECOVERED, fail → ALERT again).
Also run in CI (`build` job).

API unit tests: `apps/api/test/health.service.test.ts` (service never throws
for sick deps).

## Drill log

| Date (UTC) | Drill | Result |
|---|---|---|
| 2026-09-25 | Forced staging failure drill: `checks.sh` against a mock API returning `{"status":"degraded","checks":{"database":"unreachable"}}` → `ALERT` on first run, silence on repeat, `RECOVERED` after the mock went healthy | Pass (see `infra/health/test/test-checks.sh`) |
