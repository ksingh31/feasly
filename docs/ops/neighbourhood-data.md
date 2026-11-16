# Neighbourhood data refresh (#773)

Foundation for the Community Match epic. Outside neighbourhood sources are
fetched by **provider interfaces** on a monthly job and stored in Postgres;
request paths read our tables only and never call a provider.

## Providers

| Provider (admin path segment) | Config key | Implementations (default first) | Writes to |
|---|---|---|---|
| `school-directory` | `NEIGHBOURHOOD_SCHOOL_DIRECTORY_PROVIDER` | `free-public` (#774: City "Schools" `fd9t-tdn2` + Alberta school authority list + OpenStreetMap; see [Schools directory](#schools-directory-774)), `calgary-open-data` (City + authority list, no OSM call), `none` | `schools` |
| `school-designation` | `NEIGHBOURHOOD_SCHOOL_DESIGNATION_PROVIDER` | `none` | `school_designations` |
| `school-ratings` | `NEIGHBOURHOOD_SCHOOL_RATINGS_PROVIDER` | `none` | `school_ratings` |
| `reviews` | `NEIGHBOURHOOD_REVIEWS_PROVIDER` | `none` | `community_living_metrics` (`metric='reviews'`) |
| `amenities` | `NEIGHBOURHOOD_AMENITIES_PROVIDER` | `calgary-open-data` (one City dataset per category in `NEIGHBOURHOOD_AMENITY_CATEGORIES`, plus per-community tree cover — see below), `none` | `amenities` |
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

## Amenity categories (#777)

`NEIGHBOURHOOD_AMENITY_CATEGORIES` is a JSON array; adding, removing or
re-pointing a category is config-only. Each entry:
`{ key, label, datasetId, where?, idField?, nameField? }` — `where` is a SoQL
`$where` filter; polygons become an interior point and lines their middle
vertex. Defaults (City of Calgary open data):

| key | Dataset | Filter |
|---|---|---|
| `parks` | Parks Sites `kami-qbfh` | active; regional/district/community/neighbourhood/athletic/linear parks |
| `playgrounds` | Playground Equipment `bdu9-amk8` | active multi-play complexes, one per park site |
| `pathways` | Parks Pathways `qndb-27qm` | active; one point per segment |
| `rec-centres` | Recreation Facilities `hxfu-6d96` | leisure/aquatic & fitness centres, fieldhouses, arenas |
| `pools` | Recreation Facilities `hxfu-6d96` | indoor or outdoor pool |
| `libraries` | Community Services `x34e-bcjz` | `type='Library'` |
| `off-leash` | Parks Off Leash Areas `enr4-crti` | open |

A category that comes back empty fails the whole amenities refresh, so a
broken dataset never prunes that category's rows.

**Tree cover.** One reserved `tree-cover` row per established community
(#690), located at its centre (Community Points): City public trees
(`NEIGHBOURHOOD_PUBLIC_TREES_DATASET_ID`, counted per community) per hectare
of community area (`NEIGHBOURHOOD_COMMUNITY_BOUNDARIES_DATASET_ID`). Level:
below the first `NEIGHBOURHOOD_TREE_COVER_THRESHOLDS` value = low, at/above
the second = high, else moderate (defaults `11,16` ≈ terciles of the 114
established communities, Nov 2026). It counts City-maintained trees; it is
not a measured canopy. The row also anchors community metrics.

## Community metrics API (#777)

`GET /api/v1/communities/{slug}/living` (public, ungated; slug or City
code). Per configured category: the nearest one within
`NEIGHBOURHOOD_AMENITY_SEARCH_RADIUS_M` and counts within each
`NEIGHBOURHOOD_AMENITY_COUNT_RADII_M` (default 500 m, 1 km), straight-line
from the community centre; plus tree cover. Computed from our tables only
and reused from the shared `city_data_cache` (#756) for
`NEIGHBOURHOOD_COMMUNITY_METRICS_TTL_MS` (default 1 day). Communities without
a tree-cover row (non-established or unknown) answer 404.

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

## Schools directory (#774)

`GET /api/v1/schools?community=&type=` and `GET /api/v1/schools/{id}` serve
the `schools` table (public, free, ungated; never an outside call). The
`free-public` provider builds one list of Calgary K–12 schools
(`school-directory.ts`, pure):

1. **City "Schools"** is the base list. Post-secondary rows are dropped.
2. **Alberta school authority list** (`ALBERTA_AUTHORITIES`) gives the type:
   `public_cbe`, `catholic_ccsd`, `francophone`, `charter`, `alternative`
   (a public division based outside Calgary running a program here). Any
   other authority is a private (independent) school operator → `private`,
   so every school has a type. Update the list if Alberta adds a charter
   school or renames an authority.
3. **OpenStreetMap** (Overpass, `NEIGHBOURHOOD_OSM_OVERPASS_URL` +
   `NEIGHBOURHOOD_OSM_BBOX`) fills website, programs, grades and tuition on
   matching City schools, and adds private schools the City list lacks.
   Same school = matching normalized name within
   `NEIGHBOURHOOD_SCHOOL_DEDUPE_RADIUS_M` (default 300 m). OSM-only schools
   are kept only when OSM marks them private.
4. **Community code** = point-in-polygon against City "Community District
   Boundaries" (`NEIGHBOURHOOD_COMMUNITY_BOUNDARIES_DATASET_ID`).

Every field keeps its source in `data.sources`; responses return it per
field plus the notices for each source used (City OGL, Alberta OGL,
© OpenStreetMap contributors / ODbL). Phone numbers and emails are never
stored. If any source fails (Overpass is often slow — it has its own
`NEIGHBOURHOOD_OSM_HTTP_TIMEOUT_MS`), the refresh fails, the previous
directory stays, and the next daily tick retries.
