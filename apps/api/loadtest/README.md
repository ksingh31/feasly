# API load tests (BE8-003)

k6 scripts proving the dev API holds up under production-like load.
k6 is free/open-source — no Azure Load Testing (paid) needed, per the free-tier lock.

## Scripts

| Script | What it does | Guardrails |
|---|---|---|
| `read-paths.js` | Weighted mix of the hot reads: health (15%), community stats (25%), property autocomplete (40%), property lookup (20%) | Property endpoints are cache-first but can hit the City Socrata API on miss — keep VUs modest |
| `estimate-write.js` | POST /api/v1/estimate with valid new-build payloads | **GATED on the P0 estimate-500 fix.** 5 VUs max — each iteration writes a real row |

## Running

```bash
# Baseline (10 VUs, 2 min) against dev
k6 run -e BASE_URL=https://feasly-dev-api-4fhkep.azurewebsites.net read-paths.js

# Heavier (only if baseline is clean)
k6 run -e BASE_URL=... -e VUS=50 -e DURATION=5m read-paths.js

# Write path (after P0 fix verified)
k6 run -e BASE_URL=... estimate-write.js
```

## Budgets (from story)

- Read p95 < 3s (lookup < 5s — it fans out to the City API)
- Estimate write p95 < 8s
- Error rate < 5%

These are informational on dev; tighten before production.

## Installing k6

```bash
# Linux
curl -sL https://github.com/grafana/k6/releases/download/v0.55.0/k6-v0.55.0-linux-amd64.tar.gz | tar xz
./k6-v0.55.0-linux-amd64/k6 version
```

## Baseline results (2026-09-25, dev API)

| Run | VUs | Duration | Requests | Errors | p50 | p95 |
|---|---|---|---|---|---|---|
| read-paths | 10 | 2m | 942 | 0% | 93ms | 144ms |
| read-paths | 25 | 2m | 2,377 | 0% | 93ms | 130ms |

Per-route p95 at 25 VUs: health 127ms, autocomplete 129ms, community-stats 131ms, property-lookup 134ms. All within budget. No OOM symptoms, no latency degradation under load.

Write-path test (`estimate-write.js`) not yet run — gated on the P0 estimate-500 fix.
