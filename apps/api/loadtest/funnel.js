/**
 * #737: full-funnel load test (autocomplete → lookup → preview → estimate → lead).
 *
 * One script, three scenarios (pick with -e SCENARIO=…):
 *
 *   soak      Constant arrival rate at the 10x target for 30 min (default).
 *             500 funnels/hr ≈ 0.14/s, plus browse-only traffic for the
 *             20,000 visits/day target. Shows CPU-credit exhaustion and pool leaks.
 *   spike     Ramps arrivals from 0 to SPIKE_RATE/s and back down in about 3 min,
 *             from ONE load-generator IP with the default rate limits in place.
 *             Expected result: some 429s, each with a Retry-After header, and zero 5xx (AC3).
 *   coldstart One funnel, no warm-up. Run it after 30+ min of idle to
 *             measure the first-hit latency (AC5).
 *
 * WRITES ARE GUARDED. Preview, estimate and lead each persist rows, and a
 * lead sends a magic-link email. The write steps run only when:
 *   - WRITES=1, and
 *   - TEST_API_KEY is set and starts with `feasly_test_` (a sandbox key).
 * Otherwise the script runs the read half of the funnel only. Do not
 * enable writes until #793 lands. Before that fix, sandbox-key writes are
 * not sandbox-flagged and send real email. See README "Preconditions".
 *
 * Usage:
 *   k6 run -e BASE_URL=https://<dev-api> -e SCENARIO=spike funnel.js
 *   k6 run -e BASE_URL=... -e SCENARIO=soak -e WRITES=1 -e TEST_API_KEY=$KEY funnel.js
 *
 * Every threshold is a budget from README "Budgets". Env overrides exist only
 * so the runbook can record what was actually used.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'https://feasly-dev-api-4fhkep.azurewebsites.net';
const SCENARIO = __ENV.SCENARIO || 'soak';
const TEST_API_KEY = __ENV.TEST_API_KEY || '';
const WRITES = __ENV.WRITES === '1';

// Traffic model (README): 10x target = 500 estimates/hr, 20,000 visits/day.
const FUNNELS_PER_HOUR = parseInt(__ENV.FUNNELS_PER_HOUR || '500', 10);
const VISITS_PER_DAY = parseInt(__ENV.VISITS_PER_DAY || '20000', 10);
const SOAK_DURATION = __ENV.DURATION || '30m';
const SPIKE_RATE = parseInt(__ENV.SPIKE_RATE || '20', 10); // arrivals/s at the peak

const BUDGET_ESTIMATE_P95_MS = parseInt(__ENV.BUDGET_ESTIMATE_P95_MS || '3000', 10);
const BUDGET_PREVIEW_P95_MS = parseInt(__ENV.BUDGET_PREVIEW_P95_MS || '3000', 10);
const BUDGET_LOOKUP_P95_MS = parseInt(__ENV.BUDGET_LOOKUP_P95_MS || '5000', 10);
const BUDGET_READ_P95_MS = parseInt(__ENV.BUDGET_READ_P95_MS || '1500', 10);
const BUDGET_LEAD_P95_MS = parseInt(__ENV.BUDGET_LEAD_P95_MS || '3000', 10);
const BUDGET_COLD_START_MS = parseInt(__ENV.BUDGET_COLD_START_MS || '8000', 10);

if (WRITES && !TEST_API_KEY.startsWith('feasly_test_')) {
  throw new Error('WRITES=1 needs TEST_API_KEY to be a sandbox key (feasly_test_…). Refusing to write live rows.');
}

const lat = {
  autocomplete: new Trend('lat_autocomplete_ms', true),
  lookup: new Trend('lat_lookup_ms', true),
  preview: new Trend('lat_preview_ms', true),
  estimate: new Trend('lat_estimate_ms', true),
  lead: new Trend('lat_lead_ms', true),
  firstHit: new Trend('lat_first_hit_ms', true),
};
const serverErrors = new Counter('server_errors_5xx');
const rateLimited = new Counter('rate_limited_429');
const rateLimitedWithoutRetryAfter = new Counter('rate_limited_429_missing_retry_after');
const funnelErrors = new Rate('funnel_errors');

const SCENARIOS = {
  soak: {
    funnel: {
      executor: 'constant-arrival-rate',
      exec: 'funnel',
      rate: FUNNELS_PER_HOUR,
      timeUnit: '1h',
      duration: SOAK_DURATION,
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
    browse: {
      executor: 'constant-arrival-rate',
      exec: 'browse',
      // Browse-only visits (never reach the estimate step).
      rate: VISITS_PER_DAY,
      timeUnit: '24h',
      duration: SOAK_DURATION,
      preAllocatedVUs: 5,
      maxVUs: 30,
    },
  },
  spike: {
    spike: {
      executor: 'ramping-arrival-rate',
      exec: 'funnel',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 200,
      stages: [
        { target: SPIKE_RATE, duration: '30s' },
        { target: SPIKE_RATE, duration: '2m' },
        { target: 0, duration: '30s' },
      ],
    },
  },
  coldstart: {
    coldstart: {
      executor: 'shared-iterations',
      exec: 'coldstart',
      vus: 1,
      iterations: 1,
    },
  },
};

if (!SCENARIOS[SCENARIO]) {
  throw new Error(`Unknown SCENARIO "${SCENARIO}" (use soak | spike | coldstart)`);
}

const THRESHOLDS = {
  soak: {
    // AC2: error rate under 1%, estimate p95 under budget, zero 5xx.
    http_req_failed: ['rate<0.01'],
    funnel_errors: ['rate<0.01'],
    server_errors_5xx: ['count==0'],
    lat_autocomplete_ms: [`p(95)<${BUDGET_READ_P95_MS}`],
    lat_lookup_ms: [`p(95)<${BUDGET_LOOKUP_P95_MS}`],
    lat_preview_ms: [`p(95)<${BUDGET_PREVIEW_P95_MS}`],
    lat_estimate_ms: [`p(95)<${BUDGET_ESTIMATE_P95_MS}`],
    lat_lead_ms: [`p(95)<${BUDGET_LEAD_P95_MS}`],
  },
  spike: {
    // AC3: the limiter answers 429 + Retry-After; nothing turns into a 5xx.
    server_errors_5xx: ['count==0'],
    rate_limited_429_missing_retry_after: ['count==0'],
  },
  coldstart: {
    lat_first_hit_ms: [`max<${BUDGET_COLD_START_MS}`],
    server_errors_5xx: ['count==0'],
  },
};

export const options = {
  scenarios: SCENARIOS[SCENARIO],
  thresholds: THRESHOLDS[SCENARIO],
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max', 'count'],
};

// Verified-good autocomplete queries (2026-09-25 baseline).
const QUERIES = ['200 8 ave', '16 ave nw', '17 ave sw', '4 st sw', 'kensington'];
const TIERS = ['standard', 'premium', 'luxury'];
const GARAGES = ['none', 'double', 'triple'];
const BASEMENTS = ['unfinished', 'finished'];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function headers(write) {
  const h = { 'Content-Type': 'application/json' };
  if (write && TEST_API_KEY) h.Authorization = `Bearer ${TEST_API_KEY}`;
  return { headers: h };
}

/** Records status-class counters shared by every scenario. True on 2xx. */
function observe(res, label) {
  if (res.status >= 500) serverErrors.add(1, { route: label });
  if (res.status === 429) {
    rateLimited.add(1, { route: label });
    if (!res.headers['Retry-After']) rateLimitedWithoutRetryAfter.add(1, { route: label });
  }
  const ok = res.status >= 200 && res.status < 300;
  check(res, { [`${label} 2xx or 429`]: (r) => ok || r.status === 429 });
  return ok;
}

function autocomplete() {
  const res = http.get(
    `${BASE_URL}/api/v1/properties/autocomplete?q=${encodeURIComponent(pick(QUERIES))}`,
    { tags: { route: 'autocomplete' } },
  );
  lat.autocomplete.add(res.timings.duration);
  if (!observe(res, 'autocomplete')) return null;
  const suggestions = res.json('suggestions');
  return suggestions && suggestions.length > 0 ? pick(suggestions).addressKey : null;
}

function lookup(addressKey) {
  const res = http.get(
    `${BASE_URL}/api/v1/properties/lookup?addressKey=${encodeURIComponent(addressKey)}`,
    { tags: { route: 'lookup' } },
  );
  lat.lookup.add(res.timings.duration);
  return observe(res, 'lookup') ? res.json() : null;
}

function estimateBody(property) {
  return JSON.stringify({
    projectType: 'new_build',
    property: {
      addressKey: property.addressKey,
      assessedLandValue: property.assessedValue,
      lotSizeSqft: property.lotSqft,
      zoning: property.zoning,
    },
    scope: {
      buildSqft: 1800 + Math.floor(Math.random() * 1200),
      tier: pick(TIERS),
      garage: pick(GARAGES),
      basement: pick(BASEMENTS),
    },
  });
}

/** Full funnel. Returns false when any step failed. */
function runFunnel(firstHitTrend) {
  const started = Date.now();
  const key = autocomplete();
  if (firstHitTrend) firstHitTrend.add(Date.now() - started);
  if (!key) return false;
  sleep(1 + Math.random() * 2); // the user picks a suggestion
  const property = lookup(key);
  if (!property) return false;
  if (!WRITES) return true;

  sleep(3 + Math.random() * 5); // the user fills in the scope
  const preview = http.post(`${BASE_URL}/api/v1/estimates/preview`, estimateBody(property), {
    ...headers(true),
    tags: { route: 'preview' },
  });
  lat.preview.add(preview.timings.duration);
  if (!observe(preview, 'preview')) return false;

  const estimate = http.post(`${BASE_URL}/api/v1/estimate`, estimateBody(property), {
    ...headers(true),
    tags: { route: 'estimate' },
  });
  lat.estimate.add(estimate.timings.duration);
  if (!observe(estimate, 'estimate')) return false;
  const estimateId = estimate.json('estimateId');

  sleep(5 + Math.random() * 10); // the user reads the preview, opens the gate
  const lead = http.post(
    `${BASE_URL}/api/v1/leads`,
    JSON.stringify({
      // Reserved test domain (RFC 2606): never a real mailbox.
      email: `loadtest+${__VU}-${__ITER}-${Date.now()}@example.com`,
      name: 'Load Test',
      timeline: '6-12mo',
      marketingConsent: false,
      estimateId,
    }),
    { ...headers(true), tags: { route: 'lead' } },
  );
  lat.lead.add(lead.timings.duration);
  return observe(lead, 'lead');
}

export function funnel() {
  funnelErrors.add(runFunnel(null) ? 0 : 1);
}

export function browse() {
  const key = autocomplete();
  if (key && Math.random() < 0.5) lookup(key);
}

export function coldstart() {
  funnelErrors.add(runFunnel(lat.firstHit) ? 0 : 1);
}
