/**
 * BE8-003 — estimate write-path load test.
 *
 * POST /api/v1/estimate with valid new-build payloads. Each iteration creates
 * a real estimate row, so VU counts must stay LOW (this is a correctness +
 * latency probe, not a soak test).
 *
 * GATED: do not run until the P0 estimate-500 bug is fixed. Verify with:
 *   curl -X POST $BASE_URL/api/v1/estimate -H 'content-type: application/json' -d @payload.json
 * expecting 201/200 before running this script.
 *
 * Usage:
 *   k6 run -e BASE_URL=https://feasly-dev-api-4fhkep.azurewebsites.net estimate-write.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'https://feasly-dev-api-4fhkep.azurewebsites.net';

const estimateLatency = new Trend('lat_estimate_ms');
const errorRate = new Rate('estimate_errors');

export const options = {
  vus: 5,
  duration: '1m',
  thresholds: {
    http_req_failed: ['rate<0.05'],
    lat_estimate_ms: ['p(95)<8000'], // estimate = engine + DB write + narrative; generous budget
  },
};

function buildPayload() {
  return {
    projectType: 'new-build',
    addressKey: '200 8 Av SE',
    community: 'altadore',
    scope: {
      bedrooms: 4,
      bathrooms: 3.5,
      sqft: 2600,
      garageStalls: 2,
      basement: 'finished',
    },
    tier: 'standard',
  };
}

export default function () {
  const res = http.post(
    `${BASE_URL}/api/v1/estimate`,
    JSON.stringify(buildPayload()),
    { headers: { 'Content-Type': 'application/json' } },
  );
  estimateLatency.add(res.timings.duration);
  const ok = check(res, {
    'estimate -> 2xx': (r) => r.status >= 200 && r.status < 300,
    'estimate has id': (r) => {
      try {
        const body = r.json();
        return typeof body.estimateId === 'string' || typeof body.id === 'string';
      } catch {
        return false;
      }
    },
  });
  errorRate.add(ok ? 0 : 1);
  sleep(2 + Math.random() * 2);
}
