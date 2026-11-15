/**
 * #516 spec: per-tenant embed frame-ancestors (tools/sync-embed-csp.mjs).
 *
 * Proves the generator derives frame-ancestors from tenant config, rejects
 * unsafe origins, touches only the embed shell routes, and that the committed
 * staticwebapp.config.json is in sync with config/builders.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildEmbedCsp,
  collectAllowedOrigins,
  isReservedOrigin,
  serialiseConfig,
  SWA_CONFIG_PATH,
  syncEmbedCsp,
} from './sync-embed-csp.mjs';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'builders-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tenant = (file: string, origins: unknown) =>
  writeFileSync(join(dir, file), JSON.stringify({ tenant_key: file, allowed_origins: origins }));

const GLOBAL_CSP =
  "default-src 'self'; script-src 'self'; frame-ancestors 'none'; object-src 'none'";

const baseConfig = () => ({
  globalHeaders: { 'Content-Security-Policy': GLOBAL_CSP },
  routes: [
    { route: '/embed/v1/*', headers: { 'Content-Type': 'application/javascript' } },
    { route: '/embed/*', rewrite: '/index.html' },
    { route: '/embed', rewrite: '/index.html' },
    { route: '/builder', rewrite: '/index.html' },
  ],
});

describe('collectAllowedOrigins', () => {
  it('returns the sorted, de-duplicated union of tenant origins', () => {
    tenant('b.json', ['https://elitecraftbuilders.com', 'https://www.b.ca']);
    tenant('a.json', ['https://Builder-A.ca/', 'https://elitecraftbuilders.com']);
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    expect(collectAllowedOrigins(dir)).toEqual([
      'https://builder-a.ca',
      'https://elitecraftbuilders.com',
      'https://www.b.ca',
    ]);
  });

  it('skips IANA-reserved placeholder origins (#796)', () => {
    tenant('demo.json', ['https://demo.example.com', 'https://qa.builder.test:8443']);
    tenant('real.json', ['https://elitecraftbuilders.com']);
    expect(collectAllowedOrigins(dir)).toEqual(['https://elitecraftbuilders.com']);
  });

  it('still rejects an unsafe origin even on a reserved domain', () => {
    tenant('bad.json', ['http://demo.example.com']);
    expect(() => collectAllowedOrigins(dir)).toThrow(/bad\.json/);
  });

  it.each([
    ['*'],
    ['https://*.example.com'],
    ['http://elitecraftbuilders.com'],
    ['https://elitecraftbuilders.com/embed'],
    ["https://x.com 'unsafe-inline'"],
    ['https://x.com; script-src *'],
    ['http://localhost:4200'],
    [''],
  ])('rejects unsafe origin %j', (origin) => {
    tenant('bad.json', [origin]);
    expect(() => collectAllowedOrigins(dir)).toThrow(/bad\.json/);
  });

  it('rejects a tenant without an allowed_origins array', () => {
    tenant('bad.json', 'https://x.com');
    expect(() => collectAllowedOrigins(dir)).toThrow(/must be an array/);
  });
});

describe('isReservedOrigin', () => {
  it.each([
    'https://example.com',
    'https://demo.example.com',
    'https://a.b.example.net',
    'https://example.org:8443',
    'https://site.example',
    'https://qa.builder.test',
    'https://x.invalid',
    'https://app.localhost',
  ])('treats %s as reserved', (origin) => {
    expect(isReservedOrigin(origin)).toBe(true);
  });

  it.each([
    'https://elitecraftbuilders.com',
    'https://notexample.com',
    'https://example.com.evil.ca',
    'https://www.testing.ca',
  ])('treats %s as a real origin', (origin) => {
    expect(isReservedOrigin(origin)).toBe(false);
  });
});

describe('buildEmbedCsp', () => {
  it("swaps only frame-ancestors for 'self' + origins", () => {
    expect(buildEmbedCsp(GLOBAL_CSP, ['https://a.com', 'https://b.com'])).toBe(
      "default-src 'self'; script-src 'self'; frame-ancestors 'self' https://a.com https://b.com; object-src 'none'",
    );
  });

  it('appends frame-ancestors when the global CSP has none', () => {
    expect(buildEmbedCsp("default-src 'self'", ['https://a.com'])).toBe(
      "default-src 'self'; frame-ancestors 'self' https://a.com",
    );
  });
});

describe('syncEmbedCsp', () => {
  it('sets the tenant CSP on /embed and /embed/* and leaves other routes alone', () => {
    const out = syncEmbedCsp(baseConfig(), ['https://elitecraftbuilders.com']);
    const byRoute = Object.fromEntries(out.routes.map((r: { route: string }) => [r.route, r]));
    const expected =
      "default-src 'self'; script-src 'self'; frame-ancestors 'self' https://elitecraftbuilders.com; object-src 'none'";
    expect(byRoute['/embed'].headers['Content-Security-Policy']).toBe(expected);
    expect(byRoute['/embed/*'].headers['Content-Security-Policy']).toBe(expected);
    expect(byRoute['/embed/v1/*'].headers).toEqual({ 'Content-Type': 'application/javascript' });
    expect(byRoute['/builder'].headers).toBeUndefined();
    expect(out.globalHeaders['Content-Security-Policy']).toBe(GLOBAL_CSP);
  });

  it('does not mutate its input', () => {
    const input = baseConfig();
    syncEmbedCsp(input, ['https://a.com']);
    expect(input).toEqual(baseConfig());
  });

  it('throws when an embed shell route is missing', () => {
    const cfg = baseConfig();
    cfg.routes = cfg.routes.filter((r) => r.route !== '/embed');
    expect(() => syncEmbedCsp(cfg, [])).toThrow(/\/embed route/);
  });
});

describe('committed staticwebapp.config.json', () => {
  it('is in sync with config/builders (run tools/sync-embed-csp.mjs if this fails)', () => {
    const committed = readFileSync(SWA_CONFIG_PATH, 'utf8');
    const regenerated = serialiseConfig(syncEmbedCsp(JSON.parse(committed), collectAllowedOrigins()));
    expect(committed).toBe(regenerated);
  });

  it('ships no placeholder origin in the embed CSP (#796)', () => {
    const raw = readFileSync(SWA_CONFIG_PATH, 'utf8');
    expect(raw).not.toContain('example.com');
  });

  it('lets the Elite Craft origin frame the embed', () => {
    expect(collectAllowedOrigins()).toContain('https://elitecraftbuilders.com');
    const embed = JSON.parse(readFileSync(SWA_CONFIG_PATH, 'utf8')).routes.find(
      (r: { route: string }) => r.route === '/embed',
    );
    expect(embed.headers['Content-Security-Policy']).toMatch(
      /frame-ancestors 'self'[^;]* https:\/\/elitecraftbuilders\.com/,
    );
  });
});
