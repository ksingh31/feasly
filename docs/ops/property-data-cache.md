# Property data cache — City calls and cache hit rate (#756)

Every visitor-facing property read (autocomplete, lookup, and everything
built on them: estimator, report, narrative, MCP) goes through
`apps/api/src/services/property.service.ts`. City data is fetched once and
reused:

| Tier | Where | TTL (config) |
|---|---|---|
| In-memory | per Function instance | `PROPERTY_CACHE_TTL_MS` (roll, autocomplete), `LAND_USE_CACHE_TTL_MS` (district) |
| Durable | Postgres `city_data_cache`, shared by every instance | `PROPERTY_DB_CACHE_TTL_MS` (assessment roll, dataset `SOCRATA_DATASET_ID`), `LAND_USE_DB_CACHE_TTL_MS` (Land Use Districts, dataset `LAND_USE_DATASET_ID`) |
| Browser | `Cache-Control: public, max-age` + `ETag` / 304 on property GETs | `PROPERTY_HTTP_CACHE_MAX_AGE_S` |

- **Single-flight:** concurrent requests on one instance for the same
  uncached address (or the same autocomplete query) share one City call.
- **Failure handling:** a cache read/write slower than
  `PROPERTY_DB_CACHE_TIMEOUT_MS`, or a database error, falls through to the
  City; the lookup never fails because of the cache. City errors are never
  cached. Autocomplete results are cached in memory only (too many distinct
  queries to be worth a row each).
- **Forcing a refresh** (e.g. the City republished a correction): delete the
  rows, e.g. `DELETE FROM city_data_cache WHERE dataset_id = '4bsw-nn7w';`.
  Instances drop their in-memory copy within `PROPERTY_CACHE_TTL_MS`.

## Telemetry

The service writes one JSON trace per event (`console.info`, so it lands in
App Insights `traces`). Events never contain an address or query.

- `property_data.lookup` — one per resolution:
  `{ op: property|district|autocomplete, dataset, source: memory|db|inflight|city }`.
  Cache hit = any source other than `city`.
- `property_data.city_call` — one per upstream City request:
  `{ op, dataset, outcome: ok|error, durationMs }`.

### Cache hit rate and City call count (Log Analytics `feasly-dev-law`)

```kusto
AppTraces
| where TimeGenerated > ago(24h)
| where Message startswith '{"event":"property_data.'
| extend d = parse_json(Message)
| extend event = tostring(d.event), op = tostring(d.op), source = tostring(d.source)
| summarize
    lookups   = countif(event == 'property_data.lookup'),
    hits      = countif(event == 'property_data.lookup' and source != 'city'),
    cityCalls = countif(event == 'property_data.city_call'),
    cityErrors = countif(event == 'property_data.city_call' and tostring(d.outcome) == 'error'),
    cityP95Ms = percentileif(todouble(d.durationMs), 95, event == 'property_data.city_call')
  by op, bin(TimeGenerated, 1h)
| extend hitRate = iff(lookups == 0, real(null), round(100.0 * hits / lookups, 1))
| order by TimeGenerated desc, op asc
```

In the App Insights portal (classic schema) use `traces`, `message` and
`timestamp` instead of `AppTraces`, `Message` and `TimeGenerated`.
