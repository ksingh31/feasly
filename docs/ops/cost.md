# Cost guardrails and expected bill (#733)

Owner rules (CLAUDE.md): free tier only; no new paid resource or SKU change
without Karan's explicit approval. Budget `feasly-monthly-cap` = **CA$10/month**
(owner confirmed 2026-11-15, #680). A budget only **notifies** — it never stops
spend. The hard limits are the guardrails below.

## Hard limits (in Bicep, applied by CD)

| Guardrail | Value | Where | Owner decision |
|---|---|---|---|
| Function App max instances (Flex Consumption) | **10** (was 100) | `modules/function-app.bicep` `maximumInstanceCount`, from `main.bicep` `functionMaximumInstanceCount` | 2026-11-15 |
| Log Analytics daily ingestion cap | **0.1 GB/day** (was unlimited) | `modules/monitoring.bicep` `workspaceCapping.dailyQuotaGb`, from `main.bicep` `logAnalyticsDailyQuotaGb` | 2026-11-15 |
| Daily-cap reached alert | any `OverQuota` event → ops email | `modules/alerts.bicep` `<prefix>-law-daily-cap` | — |
| Trace volume | see "Log volume" below | `apps/api/host.json` | — |
| LLM / email daily ceilings | owned by #750 | — | pending (#750) |

What happens when a limit is hit:

- **Instance cap:** the Function App stops adding instances; under a spike, extra
  requests queue or get HTTP 429/503 from the platform. The app stays up.
- **Log Analytics cap:** ingestion pauses until 00:00 UTC. **The API keeps serving**;
  only telemetry stops (so the other log alerts go quiet until reset). The
  `law-daily-cap` alert fires; operational records (`_LogOperation`) are exempt
  from the cap, which is how the alert still sees it.

## Log volume (host.json)

Baseline (issue #733, last 30 days of dev): ~143 MB ingested, `AppTraces` 110 MB.
App code logs only warnings and errors per request (`middleware/pipeline.ts`),
so the bulk is expected to be host chatter and the two Information lines the
host writes per invocation (`Executing 'Functions.x'` / `Executed 'Functions.x'`).
Confirm with `AppTraces | summarize count() by SeverityLevel, tostring(Properties.Category)`.

`apps/api/host.json` now sets:

- `default: Warning` and `Function: Warning` — drops host lifecycle chatter and
  the per-invocation start/finish lines (failed invocations still log at Error).
- `Host.Results: Information` — keeps `AppRequests` (the 5xx alert and timer
  execution evidence) and `Host.Aggregator: Information` (metrics).
- `Function.<timer>.User: Information` for every timer — keeps the one summary
  line per run that proves a timer ran (a guard test fails if a new timer is
  missing here).
- Sampling on (5 items/s) for dependencies and events only; `Request`,
  `Exception` and `Trace` are **never** sampled, so error lines, correlation IDs
  (carried on the pipeline's warn/error lines) and alert counts stay exact.

Expected: per-1,000-request `AppTraces` drops from ~2+ lines per request to only
warn/error lines. Measure after deploy:

```kusto
let reqs = toscalar(AppRequests | where TimeGenerated > ago(1d) | count);
AppTraces | where TimeGenerated > ago(1d)
| summarize traces = count(), bytes = sum(estimate_data_size(*))
| extend per1kRequests = 1000.0 * traces / reqs
```

## Expected monthly bill per environment (estimates, CAD)

Provisional — list-price estimates, not vendor-verified. Reconcile against
Cost Management monthly (see "Monthly review"). Observed dev spend at the time
of #733: **CA$0.45 month-to-date**.

| Resource (per environment) | dev | staging | prod |
|---|---|---|---|
| Static Web App (Free) | 0 | 0 | 0 |
| Function App, Flex Consumption FC1 (2048 MB, max 10) | ~0 (inside the monthly free grant at current traffic) | ~0 | ~0–5 at launch traffic |
| Postgres Flexible Server | B1ms + 32 GB, 7-day backups: **~0 while the account's 12-month free grant covers it**, ~25 after | B1ms ~25 | B2s + 30-day backups ~55–65 |
| Storage account (Functions host + deployment) | <1 | <1 | <1 |
| Key Vault (standard ops) | <1 | <1 | <1 |
| Log Analytics + App Insights (≤0.1 GB/day cap; first 5 GB/month free) | 0 (~3 GB/month max at the cap) | 0 | 0 |
| Scheduled-query alert rules (5, 15-min frequency) | ~1–4 | ~1–4 | ~1–4 |
| Azure Communication Services email | <1 at magic-link volumes | 0 (log provider) | <1 |
| LLM narrative (external provider, Gemini + Groq fallback) | pennies; capped by #750 | — | capped by #750 |
| **Total** | **~CA$1–6** (fits the CA$10 budget) | not deployed | **~CA$60–75** — above CA$10 |

Only dev exists today. **A prod stack does not fit CA$10/month**: Postgres alone
exceeds it. Raising the budget is an owner decision (open question 1 on #733);
nothing in prod is deployed without Karan's approval.

## Budget (subscription scope — applied once by an Owner)

Thresholds (source of truth: `infra/bicep/modules/subscription-budget.bicep`):

| Notification | Type | Threshold |
|---|---|---|
| `actual50` | Actual | 50 % (CA$5) |
| `actual80` | Actual | 80 % (CA$8) |
| `actual100` | Actual | 100 % (CA$10) |
| `forecast100` | Forecasted | 100 % (CA$10) |

Each goes to the ops inbox **and a second contact** (`contactEmails`).

The CD identity is resource-group-scoped and cannot write subscription-scope
resources (#637), so the module is **not** wired into `main.bicep`. A
subscription Owner applies it (idempotent; updates the existing hand-made budget
in place):

```bash
az deployment sub what-if --location canadacentral \
  -f infra/bicep/modules/subscription-budget.bicep \
  -p startDate=2026-12-01 contactEmails='["<ops inbox>","<second contact>"]'
az deployment sub create --location canadacentral \
  -f infra/bicep/modules/subscription-budget.bicep \
  -p startDate=2026-12-01 contactEmails='["<ops inbox>","<second contact>"]'
```

Verify by reading it back (needs Cost Management Reader, #574):

```bash
az consumption budget show --budget-name feasly-monthly-cap \
  --query "{amount:amount, notifications:notifications}" -o json
```

## Verify the hard limits after CD

```bash
az resource show -g rg-feasly-dev --resource-type Microsoft.Web/sites \
  -n <feasly-dev-api-…> --query properties.functionAppConfig.scaleAndConcurrency
az monitor log-analytics workspace show -g rg-feasly-dev -n feasly-dev-law \
  --query workspaceCapping
az monitor scheduled-query show -g rg-feasly-dev -n feasly-dev-law-daily-cap \
  --query "{enabled:enabled, query:criteria.allOf[0].query}"
```

## Monthly review

The nightly ops review (`agent-ops.yml`) already checks `az consumption budget
list` against `feasly-monthly-cap` (flags >50 % before day 15, >80 % any time).
On the first run of each month, also compare last month's actual cost per
resource with the table above and file an `ops` issue when a line is off by
more than 2×:

```bash
az costmanagement query --type ActualCost --timeframe TheLastMonth \
  --scope /subscriptions/<subscription id> \
  --dataset-grouping name=ResourceType type=Dimension
```

(Adding this step to the workflow prompt is a `.github/workflows` change, which
agents cannot push — a human applies it.)

## Kill switch — what to stop first if spend runs away

Stop the cheapest-to-restore, highest-burn thing first. Every step except 1 is a
direct Azure change and needs Karan's go-ahead (CLAUDE.md).

1. **Find the burner:** Cost Management → Cost analysis, group by resource, last
   24 h. Check `AppRequests` by client/route for a scraper.
2. **LLM narrative:** revoke the narrative API keys at the provider (Gemini,
   then Groq). Reports fall back to the static guide; estimates are unaffected.
   (The `log` provider refuses to run in production, so switching provider is
   not an option.) #750 adds an automatic daily ceiling.
3. **Email:** revoke/rotate the ACS connection string or pause the nudge timer
   (`AzureWebJobs.nudge-timer.Disabled=true`). Magic links stop — lead capture
   degrades, so do this only if email is the burner.
4. **Compute:** lower `maximumInstanceCount` (e.g. to 2) via
   `az functionapp scale config set`, then make it permanent in Bicep.
5. **Logs:** lower the workspace daily cap (e.g. 0.05 GB).
6. **Last resort:** stop the Function App (`az functionapp stop`). The whole API
   goes down — the site shows errors. Postgres keeps billing while stopped, so
   stopping the app alone never zeroes the bill; stopping Postgres
   (`az postgres flexible-server stop`, auto-restarts after 7 days) is the final
   step.

Provider-side hard limits (set in each provider's console, owner access):
monthly spend cap on the Gemini and Groq API keys; Stripe and ACS usage alerts
when they go live.
