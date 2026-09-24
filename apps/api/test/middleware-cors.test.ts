/**
 * CORS allowlist enforcement (HRD-01).
 *
 * - Allowlisted origins get the echoed Access-Control-Allow-Origin + Vary.
 * - Non-allowlisted origins (e.g. evil.example) and missing Origin get
 *   NOTHING — fail-closed (story acceptance criterion 3).
 * - Localhost origins are env-gated: added only when NODE_ENV=development.
 */
import { describe, expect, it } from 'vitest';
import {
  isPreflight,
  preflightHeaders,
  resolveCorsHeaders,
} from '../src/middleware/cors';
import { loadConfig } from '../src/config';

const ALLOWLIST = ['https://feasly.com', 'https://staging.feasly.com'];

const VALID_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/feasly',
} as NodeJS.ProcessEnv;

describe('resolveCorsHeaders', () => {
  it('echoes an allowlisted origin with Vary: Origin', () => {
    expect(resolveCorsHeaders('https://feasly.com', ALLOWLIST)).toEqual({
      'Access-Control-Allow-Origin': 'https://feasly.com',
      Vary: 'Origin',
    });
  });

  it('matches case-insensitively but echoes the request origin', () => {
    expect(resolveCorsHeaders('HTTPS://FEASLY.COM', ALLOWLIST)).toEqual({
      'Access-Control-Allow-Origin': 'HTTPS://FEASLY.COM',
      Vary: 'Origin',
    });
  });

  it('gives no CORS headers to a non-allowlisted origin (evil.example)', () => {
    expect(resolveCorsHeaders('https://evil.example', ALLOWLIST)).toEqual({});
  });

  it('gives no CORS headers when Origin is absent', () => {
    expect(resolveCorsHeaders(undefined, ALLOWLIST)).toEqual({});
  });

  it('gives no CORS headers when the allowlist is empty', () => {
    expect(resolveCorsHeaders('https://feasly.com', [])).toEqual({});
  });

  it('does not wildcard or suffix-match (subdomain attack)', () => {
    expect(resolveCorsHeaders('https://feasly.com.evil.example', ALLOWLIST)).toEqual({});
    expect(resolveCorsHeaders('https://staging-feasly.com', ALLOWLIST)).toEqual({});
  });

  it('accepts a repeated Origin header by taking the first value', () => {
    expect(
      resolveCorsHeaders(['https://feasly.com', 'https://evil.example'], ALLOWLIST),
    ).toEqual({
      'Access-Control-Allow-Origin': 'https://feasly.com',
      Vary: 'Origin',
    });
  });
});

describe('isPreflight', () => {
  it('detects OPTIONS with an Origin header', () => {
    expect(isPreflight('OPTIONS', 'https://feasly.com')).toBe(true);
    expect(isPreflight('options', 'https://feasly.com')).toBe(true);
  });

  it('rejects non-OPTIONS methods and missing origins', () => {
    expect(isPreflight('POST', 'https://feasly.com')).toBe(false);
    expect(isPreflight('OPTIONS', undefined)).toBe(false);
    expect(isPreflight(undefined, 'https://feasly.com')).toBe(false);
  });
});

describe('preflightHeaders', () => {
  it('declares methods, headers and max-age', () => {
    const headers = preflightHeaders();
    expect(headers['Access-Control-Allow-Methods']).toContain('OPTIONS');
    expect(headers['Access-Control-Allow-Methods']).toContain('POST');
    expect(headers['Access-Control-Allow-Headers']).toBeTruthy();
    expect(headers['Access-Control-Max-Age']).toBeTruthy();
  });
});

describe('corsOrigins config (HRD-01 env gating)', () => {
  it('parses the CORS_ORIGINS CSV in non-dev environments', () => {
    const config = loadConfig({
      ...VALID_ENV,
      CORS_ORIGINS: 'https://feasly.com, https://staging.feasly.com',
    });
    expect(config.corsOrigins).toEqual(['https://feasly.com', 'https://staging.feasly.com']);
  });

  it('adds localhost dev-server origins only in development', () => {
    const config = loadConfig({ ...VALID_ENV, NODE_ENV: 'development' });
    expect(config.corsOrigins).toContain('http://localhost:4200');
    expect(config.corsOrigins).toContain('http://127.0.0.1:4200');
  });

  it('never adds localhost origins in production', () => {
    const config = loadConfig({
      ...VALID_ENV,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://feasly.com',
    });
    expect(config.corsOrigins).toEqual(['https://feasly.com']);
  });

  it('does not duplicate an explicitly listed localhost origin', () => {
    const config = loadConfig({
      ...VALID_ENV,
      NODE_ENV: 'development',
      CORS_ORIGINS: 'http://localhost:4200',
    });
    expect(config.corsOrigins.filter((o) => o === 'http://localhost:4200')).toHaveLength(1);
  });
});
