# API load tests (BE8-003, #737)

k6 scripts that check the API holds up at 10× the expected launch traffic.
k6 is free and open source. Azure Load Testing (paid) is not used.

## Traffic model and target (AC1)

Owner decision, 2026-11-15 (on #737). These are assumptions; update them when the
pilot's real numbers arrive.

| | Pilot peak (1×) | **Target (10×)** |
|---|---|---|
| Visits per day | 2,000 | **20,000** (about 0.23/s on average) |
| Estimates per hour, at peak | 50 | **500** (about 0.14/s) |
| Embed share | assumed 100% (the pilot runs on the builder embed) | same |

The 10× target is what `funnel.js` drives by default (`FUNNELS_PER_HOUR=500`,
`VISITS_PER_DAY=20000`). Each funnel is autocomplete → lookup → preview →
estimate → lead. Browse-only visits are autocomplete plus, half the time, a lookup.

## Budgets

These are the agreed pass marks for the soak run. They are also the k6 thresholds.

| Measure | Budget |
|---|---|
| Error rate (whole run) | < 1% |
| 5xx responses | 0 |
| Estimate p95 / preview p95 / lead p95 | < 3 s each |
| Property lookup p95 (fans out to the City API on a cache miss) | < 5 s |
| Autocomplete p95 | < 1.5 s |
| First hit after 30 min idle (cold start) | < 8 s, measured and reported (see "Cold start") |
| Postgres connection-limit errors | 0 |
| Postgres CPU credits | never reach 0 during the soak |

## Scripts

| Script | What it does |
|---|---|
| `funnel.js` | The full funnel at the 10× target, in three scenarios (below). Write steps are guarded |
| `read-paths.js` | Weighted mix of the hot reads: health, community stats, autocomplete, lookup. Useful as a quick smoke test |

`funnel.js` scenarios, chosen with `-e SCENARIO=`:

| Scenario | Shape | What it proves |
|---|---|---|
| `soak` (default) | Constant arrivals at 500 funnels/hr plus 20,000 visits/day, for 30 min (`DURATION`) | AC2: latency, error rate, pool leaks, CPU-credit drain |
| `spike` | Ramps from 0 to `SPIKE_RATE` (20) arrivals/s, holds for 2 min, then ramps down. One IP, default limits | AC3: the limiter answers 429 with `Retry-After`; no 5xx |
| `coldstart` | A single funnel with no warm-up | AC5: first-hit latency after idle |

### Write guard (AC6)

Preview, estimate and lead each write a row, and a lead sends a magic-link
email. `funnel.js` runs the write steps only with `WRITES=1` **and** a
sandbox key in `TEST_API_KEY` (it must start with `feasly_test_`). With a live
key it refuses to start. Lead emails use `loadtest+…@example.com`, a reserved
domain that never reaches a mailbox. Without `WRITES=1`, only the read half of
the funnel runs.

Sandbox rows are deleted by the existing sandbox-purge timer once they are
older than `SANDBOX_PURGE_RETENTION_DAYS` (30). Check that `SANDBOX_PURGE_DRY_RUN`
is `false` on the target. It defaults to `true`, and in dry-run mode the job only
counts rows.

## Preconditions before a write-path run

1. **#793 must be merged.** Today, writes made with a sandbox key are *not*
   sandbox-flagged and *do* send real email. A write run before that fix
   leaves rows the purge job won't touch, and sends hundreds of emails.
2. **The log daily cap from the cost-guardrails story (#733) is deployed**, so
   the run can't run up log ingestion.
3. **Per-IP limits for the soak window.** The estimate pipeline allows
   20 estimates/hr per IP (TECH_PLAN §13.3). One load generator is one IP, so a
   500/hr soak from one machine is mostly 429s by design. For the soak only, set
   `ESTIMATE_RATE_LIMIT_MAX_REQUESTS=1000` and `LEAD_RATE_LIMIT_MAX_REQUESTS=60`
   on the **dev** Function App. Put the defaults back straight after the run, and
   run the spike with the defaults in place.

## Running

```bash
API=https://feasly-dev-api-4fhkep.azurewebsites.net

# AC5: after 30+ minutes with no traffic (check App Insights first)
k6 run -e BASE_URL=$API -e SCENARIO=coldstart funnel.js

# AC3: default limits in place
k6 run -e BASE_URL=$API -e SCENARIO=spike -e WRITES=1 -e TEST_API_KEY=$FEASLY_TEST_KEY funnel.js

# AC2: per-IP limits raised for the window (precondition 3)
k6 run -e BASE_URL=$API -e SCENARIO=soak -e WRITES=1 -e TEST_API_KEY=$FEASLY_TEST_KEY funnel.js
```

During the soak, watch these on the Postgres server, from the portal Metrics blade
or with `az monitor metrics list`: `cpu_credits_remaining`,
`active_connections`, `connections_failed`, `cpu_percent`. On the Function
App, watch the instance count (App Insights `cloud_RoleInstance` distinct count)
and `requests` by result code. Record them in the results table below.

Mint the sandbox key through the admin API-keys endpoint
(`POST /api/v1/admin/api-keys` with `"sandbox": true`). Never commit it, and
never paste it into an issue or PR.

## Findings and changes (#737)

- **Per-tenant estimate limit was below the pilot's 1× peak.** The embed limiter
  (`ESTIMATE_TENANT_RATE_LIMIT_MAX_REQUESTS`) defaulted to 20/hr per builder,
  but the model says 50/hr at peak. The pilot builder's visitors would have been
  throttled at normal traffic. The default is now **600/hr**: the 10× target
  plus 20% headroom. It still caps each builder, so one viral page can't starve
  the endpoint. The per-IP limit (20/hr) is unchanged.
- **City open-data API degradation (AC4)** is covered by
  `test/property.city-degradation.test.ts`. A hanging City API gives
  `503 DEPENDENCY_UNAVAILABLE` at `PROPERTY_HTTP_TIMEOUT_MS` (15 s default), which
  is the funnel's documented "temporarily unavailable" state. A refused
  connection or a City 5xx gives the same 503 at once. Failures are never
  cached, so the same instance recovers on the next request without a restart,
  and cached records keep being served during an outage.
- **Connection budget, still to confirm by the soak.** `DB_POOL_MAX_SIZE` 5 ×
  the instance cap is the worst-case connection count. With the cap at 10
  (#790), that is 50, which is close to a Burstable B1ms server's limit (about 50,
  some reserved by Azure). The soak's `connections_failed` reading decides
  whether the pool drops to 3. Don't change it blind: a smaller pool queues
  requests within an instance.
- **Property cache is per instance** (`PROPERTY_CACHE_TTL_MS` 5 min). Under
  scale-out each new instance misses once per address. At the 10× target that is
  well inside the City API's anonymous limits. A shared Postgres cache is only
  worth building if the soak shows City 429s.

## Cold start (AC5)

**Position: accepted** (owner, 2026-11-15). No always-ready instances, because
they cost money every month. The first-hit latency is measured with
`SCENARIO=coldstart` and recorded below.

**Warm-up ping: not added.** The owner asked for one only if it is free. It
isn't useful for free:
- On Flex Consumption, HTTP functions scale as their own group, apart from timer
  triggers. A timer firing does not warm the instances that serve HTTP.
- To warm them, a timer would have to make an HTTP call to the app's own
  hostname, and do it more often than the platform's idle scale-in. The existing
  timers run hourly or daily. A cadence that keeps an instance warm (every few
  minutes) means about 9,000 extra timer and HTTP executions a month: metered,
  and also more log ingestion. That is small, but it is not free.
- The 1-hour and 30-minute timers (`nudge-timer`, `follow-up-timer`) would not
  keep an instance warm between ticks.

Revisit this if the measured cold start goes over the 8 s budget.

## Re-running before each launch milestone

Agents can't change `.github/workflows`, so the manual-dispatch workflow is
waiting for a human or devops push. Suggested `.github/workflows/loadtest.yml`:

```yaml
name: loadtest
on:
  workflow_dispatch:
    inputs:
      scenario: { type: choice, options: [coldstart, spike, soak], default: coldstart }
      writes: { type: boolean, default: false }
jobs:
  k6:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: grafana/setup-k6-action@v1
      - run: >
          k6 run -e BASE_URL=${{ vars.DEV_API_URL }} -e SCENARIO=${{ inputs.scenario }}
          ${{ inputs.writes && '-e WRITES=1' || '' }} apps/api/loadtest/funnel.js
        env:
          TEST_API_KEY: ${{ secrets.FEASLY_TEST_API_KEY }}
```

(`k6 run` passes system environment variables into `__ENV`, so `TEST_API_KEY`
reaches the script without a `-e` flag.)

## Results

| Date | Run | Target | Requests | Errors | p50 | p95 | p99 | Notes |
|---|---|---|---|---|---|---|---|---|
| 2026-09-25 | read-paths, 10 VUs, 2 min | n/a | 942 | 0% | 93 ms | 144 ms | n/a | dev |
| 2026-09-25 | read-paths, 25 VUs, 2 min | n/a | 2,377 | 0% | 93 ms | 130 ms | n/a | dev |
| 2026-11-15 | funnel `coldstart`, reads only | n/a | 2 | 0% | 512 ms | 725 ms | n/a | first hit 844 ms. Dev was **not** idle (other agents active), so this is a warm baseline, not AC5 |
| pending | funnel `spike`, writes | AC3 | | | | | | blocked on #793 |
| pending | funnel `soak` 30 min, writes | AC2 | | | | | | blocked on #793, #733 |
| pending | funnel `coldstart` after 30 min idle | AC5 | | | | | | needs an idle window on dev |

## Installing k6

```bash
curl -sL https://github.com/grafana/k6/releases/download/v0.55.0/k6-v0.55.0-linux-amd64.tar.gz | tar xz
./k6-v0.55.0-linux-amd64/k6 version
```
