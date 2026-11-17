# Neighbourhood data refresh (#773)

Foundation for the Community Match epic. Outside neighbourhood sources are
fetched by **provider interfaces** on a monthly job and stored in Postgres;
request paths read our tables only and never call a provider.

## Providers

| Provider (admin path segment) | Config key | Implementations (default first) | Writes to |
|---|---|---|---|
| `school-directory` | `NEIGHBOURHOOD_SCHOOL_DIRECTORY_PROVIDER` | `free-public` (#774: City "Schools" `fd9t-tdn2` + Alberta school authority list + OpenStreetMap; see [Schools directory](#schools-directory-774)), `calgary-open-data` (City + authority list, no OSM call), `none` | `schools` |
| `school-designation` | `NEIGHBOURHOOD_SCHOOL_DESIGNATION_PROVIDER` | `none`, `board-published` (#775: CBE + CCSD designations transcribed from the boards' notices; see [School designations](#school-designations-775)) | `school_designations` |
| `school-ratings` | `NEIGHBOURHOOD_SCHOOL_RATINGS_PROVIDER` | `none`, `published-reports` (#776: Fraser score, Alberta Education provincial results, CBE enrolment vs capacity, transcribed from the published reports; see [School ratings](#school-ratings-and-reviews-link-776)) | `school_ratings` |
| `reviews` | `NEIGHBOURHOOD_REVIEWS_PROVIDER` | `maps-link` (#776: a Google Maps search link per school, built at read time — no API call), `none` | nothing (`maps-link` stores nothing; the job skips it) |
| `amenities` | `NEIGHBOURHOOD_AMENITIES_PROVIDER` | `calgary-open-data` (one City dataset per category in `NEIGHBOURHOOD_AMENITY_CATEGORIES`, plus per-community tree cover — see below), `none` | `amenities` |
| `commute` | `NEIGHBOURHOOD_COMMUTE_PROVIDER` | `straight-line` (City "Community Points", `j9ps-fyst` → straight-line km to `NEIGHBOURHOOD_COMMUTE_DESTINATION_*`), `none` | `community_living_metrics` (`metric='commute'`) |

`none` means no source has been chosen yet: the job skips it and leaves any
existing rows alone. An implementation that stores nothing (`maps-link`) is
skipped the same way.

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

## School designations (#775)

CBE and CCSD publish designated schools **by community** (designation maps
and notices); there is no open boundary file. The `board-published`
provider reads a curated list transcribed from those notices,
`apps/api/src/services/neighbourhood-data/school-designations.data.ts`: one
entry per established community (#690), board (`cbe`, `ccsd`) and grade band
(`K-6` or `K-9`, `7-9`, `10-12`), with the notice URL and school year. An
invalid or duplicated entry, or an empty list, fails the refresh and keeps
the stored designations. `NEIGHBOURHOOD_SCHOOL_DESIGNATION_PROVIDER` stays
`none` until the list is filled; then set it to `board-published`.

**API (public, free, ungated; tables only):**

- `GET /api/v1/communities/{slug}/school-designations` — slug or City code;
  404 when the community has no anchor row (not established / unknown).
- `GET /api/v1/school-designations?addressKey=` — via the address's
  community (cache-first property lookup, #756). Always answers.

Every designation is labelled **"typically designated"** and links to its
board's address lookup (`NEIGHBOURHOOD_CBE_DESIGNATION_LOOKUP_URL`,
`NEIGHBOURHOOD_CCSD_DESIGNATION_LOOKUP_URL`); every response also lists both
boards' lookup links, even when no designation is stored.

**Change review.** Each refresh diffs the new snapshot against the stored
one (by board + community + grade band; school names compare
case-insensitively; the first load is not a change). Any change opens **one**
GitHub issue, "School designations changed — review needed" (labels `ops`,
`area:api`; same repo/token as the zoning watch, `ZONING_WATCH_GITHUB_*`).
While that issue is open, later changes are added as comments. If GitHub
fails, the refresh fails and writes nothing, so the change is retried the
next day and never stored unreviewed. No token → the change is logged and
stored. The `provider_refresh` trace carries `changesFlagged`.

## School ratings and reviews link (#776)

None of the three sources publishes an open feed, so the `published-reports`
provider reads a curated list transcribed from the published reports,
`apps/api/src/services/neighbourhood-data/school-ratings.data.ts` — one entry
per directory school id (#774) and kind, each with its https source URL:

| Kind | Source | Fields |
|---|---|---|
| `fraser` | Fraser Institute, Report Card on Alberta's Schools | overall score (0–10), report year |
| `provincial` | Alberta Education provincial results (where published) | school year; per test (`pat6`, `pat9`, `diploma`): % acceptable standard, % standard of excellence (null when not published) |
| `enrolment` | CBE annual enrolment report | school year, enrolment, capacity (utilization % is computed) |

Copy figures exactly as published; never estimate one. An invalid or
duplicated entry, or an empty list, fails the refresh and keeps the stored
ratings. `NEIGHBOURHOOD_SCHOOL_RATINGS_PROVIDER` stays `none` until the list
is filled; then set it to `published-reports` (or run admin refresh-now for
`school-ratings`).

**Fraser flag.** `NEIGHBOURHOOD_SCHOOL_RATINGS_FRASER_ENABLED` (default
`false`; Bicep sets it `true` in dev only). Off: Fraser entries are not
stored by the refresh **and** are never returned, even if rows remain from
when it was on. Prod stays off until the owner confirms Fraser's permission.

**API.** `GET /api/v1/schools` and `GET /api/v1/schools/{id}` return each
school with `ratings` (`fraser`, `provincialResults`, `enrolment` — each
`null` when not published; the UI shows "n/a") with attribution + source URL,
and `reviews`: with `maps-link`, a Google Maps search link
(`NEIGHBOURHOOD_REVIEWS_MAPS_SEARCH_URL` + school name and address) — no API
call, nothing stored; `null` with `none`. A paid Places implementation can be
added later behind the same config key.
