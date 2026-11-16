/**
 * check-openapi-breaking.test.mjs — #765 AC4: prove the OpenAPI
 * breaking-change guard bites on breaking fixtures, passes additive ones,
 * and lets a version bump through.
 *
 * Run: node --test tools/check-openapi-breaking.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  checkOpenApiCompat,
  findBreakingChanges,
  isBreakingBump,
} from './check-openapi-breaking.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-openapi-breaking.mjs');

/** A small but realistic baseline: $refs, required fields, enums, params. */
function baseSpec() {
  return {
    openapi: '3.1.0',
    info: { title: 'Fixture', version: '1.2.0' },
    paths: {
      '/v1/estimate': {
        post: {
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/EstimateRequest' } },
            },
          },
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/EstimateResponse' } },
              },
            },
            400: { description: 'bad' },
          },
        },
      },
      '/v1/properties/lookup': {
        get: {
          parameters: [
            { in: 'query', name: 'addressKey', required: true, schema: { type: 'string', maxLength: 200 } },
            { in: 'query', name: 'fields', required: false, schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['addressKey', 'zoning'],
                    properties: {
                      addressKey: { type: 'string' },
                      zoning: { type: 'string' },
                      lotSqft: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        EstimateRequest: {
          type: 'object',
          required: ['addressKey', 'tier'],
          properties: {
            addressKey: { type: 'string', minLength: 1 },
            tier: { type: 'string', enum: ['standard', 'premium', 'luxury'] },
            garage: { type: 'string', enum: ['none', 'double'] },
            buildSqft: { type: 'integer', minimum: 400, maximum: 10000 },
          },
        },
        EstimateResponse: {
          type: 'object',
          required: ['estimateId', 'disclaimer', 'figures'],
          properties: {
            estimateId: { type: 'string' },
            disclaimer: { type: 'string' },
            figures: {
              type: 'object',
              required: ['total'],
              properties: { total: { $ref: '#/components/schemas/CostRange' } },
            },
            rows: { type: 'array', items: { $ref: '#/components/schemas/CostRange' } },
          },
        },
        CostRange: {
          type: 'object',
          required: ['low', 'high'],
          properties: { low: { type: 'number' }, high: { type: 'number' } },
        },
      },
    },
  };
}

/** Deep-clone the baseline and apply a mutation. */
function mutate(fn, version) {
  const spec = structuredClone(baseSpec());
  fn(spec);
  if (version) spec.info.version = version;
  return spec;
}

const S = (spec) => spec.components.schemas;
const lookup = (spec) => spec.paths['/v1/properties/lookup'].get;

describe('additive changes pass', () => {
  const additive = {
    'identical spec': () => {},
    'new path': (s) => {
      s.paths['/v1/zoning/districts'] = { get: { responses: { 200: { description: 'ok' } } } };
    },
    'new operation on an existing path': (s) => {
      s.paths['/v1/estimate'].get = { responses: { 200: { description: 'ok' } } };
    },
    'new optional query parameter': (s) => {
      lookup(s).parameters.push({ in: 'query', name: 'year', required: false, schema: { type: 'integer' } });
    },
    'new optional request property': (s) => {
      S(s).EstimateRequest.properties.basement = { type: 'string' };
    },
    'new request enum value': (s) => {
      S(s).EstimateRequest.properties.garage.enum.push('triple');
    },
    'relaxed request limits': (s) => {
      S(s).EstimateRequest.properties.buildSqft.maximum = 20000;
      S(s).EstimateRequest.properties.buildSqft.minimum = 100;
    },
    'request property now nullable': (s) => {
      S(s).EstimateRequest.properties.garage.type = ['string', 'null'];
    },
    'new response property': (s) => {
      S(s).EstimateResponse.properties.costDataVersion = { type: 'string' };
    },
    'response property made required': (s) => {
      S(s).EstimateResponse.required.push('rows');
    },
    'request property no longer required': (s) => {
      S(s).EstimateRequest.required = ['addressKey'];
    },
    'new error response': (s) => {
      s.paths['/v1/estimate'].post.responses[429] = { description: 'slow down' };
    },
  };
  for (const [name, fn] of Object.entries(additive)) {
    it(name, () => {
      assert.deepEqual(findBreakingChanges(baseSpec(), mutate(fn)), []);
    });
  }
});

describe('breaking changes fail', () => {
  const breaking = {
    'path removed': [(s) => delete s.paths['/v1/properties/lookup'], /path removed/],
    'operation removed': [(s) => delete s.paths['/v1/estimate'].post, /operation removed/],
    'new required parameter': [
      (s) => lookup(s).parameters.push({ in: 'query', name: 'year', required: true, schema: { type: 'integer' } }),
      /new required query parameter "year"/,
    ],
    'optional parameter became required': [
      (s) => { lookup(s).parameters[1].required = true; },
      /parameter "fields" became required/,
    ],
    'parameter maxLength tightened': [
      (s) => { lookup(s).parameters[0].schema.maxLength = 100; },
      /maxLength tightened/,
    ],
    'new required request property': [
      (s) => {
        S(s).EstimateRequest.properties.basement = { type: 'string' };
        S(s).EstimateRequest.required.push('basement');
      },
      /basement: request property is now required/,
    ],
    'request enum value removed': [
      (s) => { S(s).EstimateRequest.properties.tier.enum = ['standard', 'premium']; },
      /enum value\(s\) removed: "luxury"/,
    ],
    'request type changed': [
      (s) => { S(s).EstimateRequest.properties.buildSqft.type = 'string'; },
      /request type narrowed/,
    ],
    'request minimum raised': [
      (s) => { S(s).EstimateRequest.properties.buildSqft.minimum = 800; },
      /minimum tightened/,
    ],
    'response property removed (through $ref)': [
      (s) => { delete S(s).EstimateResponse.properties.disclaimer; },
      /disclaimer: response property removed/,
    ],
    'nested response property removed (array items $ref)': [
      (s) => { delete S(s).CostRange.properties.high; },
      /rows\[\]\.high: response property removed/,
    ],
    'response property no longer required': [
      (s) => { S(s).EstimateResponse.required = ['estimateId', 'figures']; },
      /disclaimer: response property no longer required/,
    ],
    'response property became nullable': [
      (s) => { S(s).EstimateResponse.properties.estimateId.type = ['string', 'null']; },
      /response type widened/,
    ],
    'success response removed': [
      (s) => { delete lookup(s).responses[200]; },
      /200 response removed/,
    ],
    'response media type removed': [
      (s) => {
        const r = s.paths['/v1/estimate'].post.responses[200];
        r.content = { 'text/plain': r.content['application/json'] };
      },
      /media type application\/json removed/,
    ],
    'security changed': [
      (s) => { s.paths['/v1/properties/lookup'].get.security = [{ apiKey: [] }]; },
      /security requirements changed/,
    ],
  };
  for (const [name, [fn, pattern]] of Object.entries(breaking)) {
    it(name, () => {
      const out = findBreakingChanges(baseSpec(), mutate(fn));
      assert.ok(out.length > 0, `expected a breaking change, got none`);
      assert.ok(out.some((m) => pattern.test(m)), `no message matched ${pattern}: ${out.join(' | ')}`);
    });
  }

  it('request body became required', () => {
    const base = mutate((s) => { s.paths['/v1/estimate'].post.requestBody.required = false; });
    const out = findBreakingChanges(base, baseSpec());
    assert.ok(out.some((m) => /request body became required/.test(m)), out.join(' | '));
  });
});

describe('version bump', () => {
  const breakingHead = (v) => mutate((s) => { delete S(s).EstimateResponse.properties.disclaimer; }, v);

  it('isBreakingBump: major, or minor under 0.x', () => {
    assert.equal(isBreakingBump('1.2.0', '2.0.0'), true);
    assert.equal(isBreakingBump('1.2.0', '1.3.0'), false);
    assert.equal(isBreakingBump('1.2.0', '1.2.1'), false);
    assert.equal(isBreakingBump('0.1.0', '0.2.0'), true);
    assert.equal(isBreakingBump('0.1.0', '0.1.5'), false);
    assert.equal(isBreakingBump('0.1.0', 'garbage'), false);
  });

  it('a breaking change without a bump fails', () => {
    const r = checkOpenApiCompat(baseSpec(), breakingHead('1.2.0'));
    assert.equal(r.ok, false);
    assert.equal(r.bumped, false);
  });

  it('a breaking change with a major bump passes (and still lists the changes)', () => {
    const r = checkOpenApiCompat(baseSpec(), breakingHead('2.0.0'));
    assert.equal(r.ok, true);
    assert.ok(r.breaking.length > 0);
  });

  it('--head-version overrides the head document version', () => {
    const r = checkOpenApiCompat(baseSpec(), breakingHead('0.0.0-ci'), '2.0.0');
    assert.equal(r.ok, true);
  });
});

describe('CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openapi-breaking-'));
  const write = (name, obj) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };
  const run = (args) => {
    try {
      return { code: 0, out: execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  const base = write('base.json', baseSpec());

  it('exits 1 on a deliberately breaking fixture', () => {
    const head = write('breaking.json', mutate((s) => { delete s.paths['/v1/properties/lookup']; }));
    const r = run(['--base', base, '--head', head]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /OPENAPI BREAKING-CHANGE CHECK FAILED/);
  });

  it('exits 0 on an additive fixture', () => {
    const head = write('additive.json', mutate((s) => {
      S(s).EstimateResponse.properties.costDataVersion = { type: 'string' };
    }));
    const r = run(['--base', base, '--head', head]);
    assert.equal(r.code, 0, r.out);
  });

  it('exits 0 on a breaking fixture with --head-version bumped', () => {
    const head = write('breaking2.json', mutate((s) => { delete s.paths['/v1/properties/lookup']; }));
    const r = run(['--base', base, '--head', head, '--head-version', '2.0.0']);
    assert.equal(r.code, 0, r.out);
  });

  it('--write-baseline stamps the head version', () => {
    const head = write('h.json', mutate(() => {}, '0.0.0-ci'));
    const out = join(dir, 'baseline.json');
    const r = run(['--head', head, '--head-version', '3.1.4', '--write-baseline', out]);
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).info.version, '3.1.4');
  });

  it('the committed baseline is a valid OpenAPI document with a semver version', () => {
    const baseline = JSON.parse(readFileSync(join(HERE, 'openapi-baseline.json'), 'utf8'));
    assert.match(baseline.openapi, /^3\./);
    assert.match(baseline.info.version, /^\d+\.\d+\.\d+$/);
    assert.ok(Object.keys(baseline.paths).length > 0);
  });
});
