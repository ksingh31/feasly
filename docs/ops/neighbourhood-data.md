# Neighbourhood data refresh (#773)

Foundation for the Community Match epic. Outside neighbourhood sources are
fetched by **provider interfaces** on a monthly job and stored in Postgres;
request paths read our tables only and never call a provider.

## Providers

| Provider (admin path segment) | Config key | Implementations (default first) | Writes to |
|---|---|---|---|
| `school-directory` | `NEIGHBOURHOOD_SCHOOL_DIRECTORY_PROVIDER` | `calgary-open-data` (City "Schools", `fd9t-tdn2`), `none` | `schools` |
| `school-designation` | `NEIGHBOURHOOD_SCHOOL_DESIGNATION_PROVIDER` | `none` | `school_designations` |
| `school-ratings` | `NEIGHBOURHOOD_SCHOOL_RATINGS_PROVIDER` | `none` | `school_ratings` |
| `reviews` | `NEIGHBOURHOOD_REVIEWS_PROVIDER` | `none` | `community_living_metrics` (`metric='reviews'`) |
| `amenities` | `NEIGHBOURHOOD_AMENITIES_PROVIDER` | `calgary-open-data` (City "Community Services", `x34e-bcjz`), `none` | `amenities` |
| `commute` | `NEIGHBOURHOOD_COMMUTE_PROVIDER` | `straight-line` (City "Community Points", `j9ps-fyst` → straight-line km to `NEIGHBOURHOOD_COMMUTE_DESTINATION_*`), `none` | `community_living_metrics` (`metric='commute'`) |

`none` means no source has been chosen yet: the job skips it and leaves any
existing rows alone. No free, open source exists today for designations,
ratings or reviews; a later story adds an implementation and flips the config.

Switching an implementation is config-only. Row ids are
`<implementation>:<external id>`, and the provider becomes due right away when
its implementation changes, so the new source's first successful refresh
replaces the old rows.

`commute` covers established infill communities only (#690 rule):
`NEIGHBOURHOOD_COMMUNITY_CLASS` + `NEIGHBOURHOOD_COMMUNITY_STRUCTURES`.

## Schedule

- Timer `neighbourhood-data-refresh-timer` ticks **daily at 07:00 UTC**.
- The monthly schedule is config: a provider is due once its last success is
  older than 00:00 UTC on `NEIGHBOURHOOD_REFRESH_DAY_OF_MONTH` (default 1).
- A provider that fails is retried on the next daily tick. Providers that
  already finished are not re-run, so an interrupted run picks up where it
  stopped.

## Guarantees

- **Idempotent:** upsert by id; `rows_changed` counts only content changes.
- **Keeps previous data on failure:** a provider error or an empty snapshot
  from a real source writes nothing; the write is one transaction.
- **One ops alert** (`neighbourhood_data_failed`) once a provider has been
  failing for `NEIGHBOURHOOD_ALERT_AFTER_FAILURE_DAYS` (default 3) days, and
  one all-clear once nothing is failing.

## Refresh now (admin)

`POST /api/v1/admin/neighbourhood-data/{provider}/refresh` (`ops:manage`),
audit-logged in `admin_audit_log` as `neighbourhood_data_refresh_manual`.

## Telemetry

One JSON trace per provider run and one per job run:

```kusto
traces
| where message startswith '{"event":"neighbourhood_data.'
| extend e = parse_json(message)
| project timestamp, event = tostring(e.event), provider = tostring(e.provider),
          outcome = tostring(e.outcome), rowsChanged = toint(e.rowsChanged),
          consecutiveFailures = toint(e.consecutiveFailures)
```

## Per-address metrics

`lot_living_metrics` caches the metrics for each address (schools within
`NEIGHBOURHOOD_LOT_RADIUS_M`, amenity counts by category). They are computed
from the tables above when first requested and reused for
`NEIGHBOURHOOD_LOT_METRICS_TTL_MS`. Distances are straight-line, not travel times.
