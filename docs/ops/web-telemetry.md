# Real-user monitoring — web vitals + JS errors (#830)

The web app reports **Core Web Vitals** (LCP, INP, CLS, TTFB, via the ~2 kB
`web-vitals` library, lazy-loaded so it stays out of the initial bundle) and
**uncaught JavaScript errors** (`window` `error` / `unhandledrejection` plus
Angular's `GlobalErrorHandler`) for a sample of page loads. There is no
browser App Insights SDK.

## Flow

1. `WebTelemetryService` (`apps/web/src/app/core/telemetry/`) starts after
   config loads, browser only. It is off when `telemetry.enabled` is false,
   in mock-API mode, or when the page load is not sampled in
   (`telemetry.sampleRate`, default **0.25**).
2. Items queue in memory and go out with `navigator.sendBeacon` when the
   page is hidden (or a batch of `telemetry.maxBatchItems` fills) as a
   `text/plain` JSON body — a CORS-safelisted type, so no preflight.
3. `POST /api/v1/telemetry` (`apps/api/src/functions/telemetry.ts`) runs on
   its own pipeline with a tight limiter (`WEB_TELEMETRY_RATE_LIMIT_*`,
   default 10/min per IP — a real page load sends 1–2 beacons), validates
   the closed `WebTelemetryBatch` contract, scrubs emails + query strings,
   and writes **one JSON trace per item** with `console.info`. A
   per-instance budget (`WEB_TELEMETRY_MAX_TRACES_PER_MINUTE`, default 60)
   drops items past it, so one client can't exhaust the 0.1 GB/day Log
   Analytics cap and silence every server trace for the day. `host.json` keeps
   `Function.telemetry.User` at `Information` so the traces reach
   App Insights. Nothing is stored in Postgres.

## Privacy

- `page` is the Angular **route pattern** (`/report/:token`), never the
  concrete URL — no ids, tokens or query strings.
- Error `source` keeps the script path only; messages are truncated
  (`telemetry.maxMessageLength`) and server-side scrubbed of emails and
  `?…`/`#…` suffixes.
- No session id, user id, cookie, storage or user agent is sent by the client.
  Errors are capped at `telemetry.maxErrorsPerSession` per page load.

## Queries (Log Analytics `feasly-dev-law`, or App Insights → Logs)

p75 web vitals by page (last 7 days):

```kusto
AppTraces
| where TimeGenerated > ago(7d)
| where Message startswith '{"event":"web_vital"'
| extend d = parse_json(Message)
| project page = tostring(d.page), name = tostring(d.name), value = todouble(d.value), rating = tostring(d.rating)
| summarize p75 = percentile(value, 75), samples = count(), poor = countif(rating == 'poor') by page, name
| order by page asc, name asc
```

Top JS errors (last 7 days):

```kusto
AppTraces
| where TimeGenerated > ago(7d)
| where Message startswith '{"event":"web_error"'
| extend d = parse_json(Message)
| summarize occurrences = count(), pages = make_set(tostring(d.page), 10), lastSeen = max(TimeGenerated)
    by message = tostring(d.message), source = tostring(d.source), kind = tostring(d.kind)
| top 20 by occurrences desc
```

In the classic App Insights `traces` table use `message` and `timestamp`
instead of `Message` and `TimeGenerated`. To pin either query to a workbook:
App Insights → Workbooks → New → Add query → paste → Save.

## Free-tier volume estimate

Per sampled page load: ~4 vitals traces + (rarely) error traces, plus 1–2
`AppRequests` rows for the beacon(s). At roughly 1 KB per row that is about
**6 KB per sampled page load**.

| Page loads / day | Sampled (25%) | Ingest / day | Ingest / month |
|---|---|---|---|
| 1,000 | 250 | ~1.5 MB | ~45 MB |
| 10,000 | 2,500 | ~15 MB | ~450 MB |
| 60,000 | 15,000 | ~90 MB | ~2.7 GB |

The first 5 GB/month of Log Analytics ingestion is free, and the workspace
has a **0.1 GB/day** cap (docs/ops/cost.md). Telemetry alone reaches that
cap at about **65,000 page loads/day** at 25% sampling. If traffic gets near
that, lower `telemetry.sampleRate` in the served `app-config.json` (no
deploy of code needed) — e.g. 0.05 cuts volume by 5×.
