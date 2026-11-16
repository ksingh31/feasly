/**
 * #844 / #954 — one CORS allowlist, two layers that both read it.
 * Static drift guard over the IaC (live state is read back with
 * `az functionapp cors show`, see docs/cd-runbook.md "CORS"; the health
 * watch also probes a real preflight — infra/health/checks.sh).
 *
 * In Azure the Functions host answers EVERY OPTIONS preflight itself (204)
 * before the worker runs, so platform `siteConfig.cors` must carry the same
 * allowlist as the in-app middleware's `CORS_ORIGINS`. #947 pinned it empty
 * and every cross-origin JSON POST from the SWA broke (#954). It must still
 * be pinned explicitly — omitting `siteConfig.cors` keeps whatever the live
 * site has, so Bicep and Azure drift apart.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(__dirname, '..', '..', '..');
const mod = readFileSync(join(repo, 'infra', 'bicep', 'modules', 'function-app.bicep'), 'utf8');
const main = readFileSync(join(repo, 'infra', 'bicep', 'main.bicep'), 'utf8');

describe('#954 CORS: platform answers preflights from the same allowlist', () => {
  it('pins platform siteConfig.cors to corsAllowedOrigins with credentials (never empty)', () => {
    expect(mod).toMatch(
      /^\s*cors: \{\s*allowedOrigins: corsAllowedOrigins\s*supportCredentials: true\s*\}/m,
    );
    expect(mod).not.toMatch(/allowedOrigins: \[\]/);
  });

  it('declares platform cors exactly once', () => {
    expect(mod.match(/^\s*cors: \{/gm)).toHaveLength(1);
  });

  it('feeds the same allowlist to the in-app middleware via CORS_ORIGINS', () => {
    expect(mod).toMatch(/name: 'CORS_ORIGINS'\s*value: join\(corsAllowedOrigins, ','\)/);
  });

  it('never allows a wildcard origin (credentials are on)', () => {
    const block = main.slice(main.indexOf('corsAllowedOrigins: ['));
    const list = block.slice(0, block.indexOf(']'));
    expect(list).not.toContain("'*'");
    expect(list).toContain("'https://${staticWebApp.outputs.hostname}'");
  });
});
