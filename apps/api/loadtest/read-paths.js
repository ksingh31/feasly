/**
 * BE8-003 — baseline read-path load test.
 *
 * Exercises the hot read paths against the dev API:
 *   - GET /api/health
 *   - GET /api/v1/communities/{slug}/stats
 *   - GET /api/v1/properties/autocomplete?q=…
 *   - GET /api/v1/properties/lookup?addressKey=… (key taken from autocomplete,
 *     mirroring the real wizard flow)
 *
 * Usage:
 *   k6 run -e BASE_URL=https://feasly-dev-api-4fhkep.azurewebsites.net read-paths.js
 *   k6 run -e BASE_URL=... -e VUS=50 -e DURATION=5m read-paths.js
 *
 * Guardrails: start at 10 VUs. Property endpoints are cache-first but still
 * hit the City of Calgary Socrata API on miss — keep VU counts modest so we
 * don't hammer a free external dependency.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'https://feasly-dev-api-4fhkep.azurewebsites.net';
const VUS = parseInt(__ENV.VUS || '10', 10);
const DURATION = __ENV.DURATION || '2m';

const latencyByRoute = {
  health: new Trend('lat_health_ms'),
  communityStats: new Trend('lat_community_stats_ms'),
  autocomplete: new Trend('lat_autocomplete_ms'),
  propertyLookup: new Trend('lat_property_lookup_ms'),
};
const errorRate = new Rate('errors');

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    // Informational budgets, not hard gates: reads should stay interactive.
    http_req_failed: ['rate<0.05'],
    lat_community_stats_ms: ['p(95)<3000'],
    lat_autocomplete_ms: ['p(95)<3000'],
    lat_property_lookup_ms: ['p(95)<5000'],
  },
};

// Verified-good inputs (2026-09-25). Slugs verified 200 on dev; autocomplete
// queries return suggestions whose addressKey feeds the lookup.
const COMMUNITIES = ['altadore', 'aspen-woods', 'mission', 'hillhurst', 'inglewood', 'signal-hill', 'tuscany', 'evergreen'];
const AUTOCOMPLETE_QUERIES = ['200 8 ave', '16 ave nw', '17 ave sw', '4 st sw', 'kensington'];

function record(metric, res, label, expectedStatus = 200) {
  metric.add(res.timings.duration);
  const ok = check(res, { [`${label} -> ${expectedStatus}`]: (r) => r.status === expectedStatus });
  errorRate.add(ok ? 0 : 1);
  return ok;
}

export default function () {
  const pick = Math.random();
  if (pick < 0.15) {
    const res = http.get(`${BASE_URL}/api/health`);
    record(latencyByRoute.health, res, 'health');
  } else if (pick < 0.40) {
    const slug = COMMUNITIES[Math.floor(Math.random() * COMMUNITIES.length)];
    const res = http.get(`${BASE_URL}/api/v1/communities/${slug}/stats`);
    record(latencyByRoute.communityStats, res, 'community-stats');
  } else if (pick < 0.65) {
    const q = AUTOCOMPLETE_QUERIES[Math.floor(Math.random() * AUTOCOMPLETE_QUERIES.length)];
    const res = http.get(`${BASE_URL}/api/v1/properties/autocomplete?q=${encodeURIComponent(q)}`);
    record(latencyByRoute.autocomplete, res, 'autocomplete');
  } else {
    // Real user flow: autocomplete first, then look up the returned key.
    const q = AUTOCOMPLETE_QUERIES[Math.floor(Math.random() * AUTOCOMPLETE_QUERIES.length)];
    const ac = http.get(`${BASE_URL}/api/v1/properties/autocomplete?q=${encodeURIComponent(q)}`);
    record(latencyByRoute.autocomplete, ac, 'autocomplete');
    let key = null;
    try {
      const suggestions = ac.json('suggestions');
      if (suggestions && suggestions.length > 0) key = suggestions[0].addressKey;
    } catch {
      key = null;
    }
    if (key) {
      const res = http.get(`${BASE_URL}/api/v1/properties/lookup?addressKey=${encodeURIComponent(key)}`);
      record(latencyByRoute.propertyLookup, res, 'property-lookup');
    }
  }
  sleep(0.5 + Math.random() * 1.5); // ~0.5–2s think time between requests
}
