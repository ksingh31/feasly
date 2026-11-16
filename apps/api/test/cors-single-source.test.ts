/**
 * #844 — exactly one CORS enforcement point: the in-app middleware.
 * Static drift guard over the IaC (live state is read back with
 * `az functionapp cors show`, see docs/cd-runbook.md "CORS").
 *
 * Platform CORS must be pinned explicitly EMPTY in Bicep: omitting
 * `siteConfig.cors` leaves whatever the live site already has (dev carried
 * `supportCredentials: true`), so Bicep and Azure drift apart.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(__dirname, '..', '..', '..');
const mod = readFileSync(join(repo, 'infra', 'bicep', 'modules', 'function-app.bicep'), 'utf8');

describe('#844 single CORS source', () => {
  it('pins platform siteConfig.cors to no origins and no credentials', () => {
    expect(mod).toMatch(
      /^\s*cors: \{\s*allowedOrigins: \[\]\s*supportCredentials: false\s*\}/m,
    );
  });

  it('declares platform cors exactly once (no second, non-empty block)', () => {
    expect(mod.match(/^\s*cors: \{/gm)).toHaveLength(1);
  });

  it('still feeds the allowlist to the in-app middleware via CORS_ORIGINS', () => {
    expect(mod).toMatch(/name: 'CORS_ORIGINS'\s*value: join\(corsAllowedOrigins, ','\)/);
  });
});
