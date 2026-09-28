/**
 * Copy-drift tripwire (QA 2026-09-27).
 *
 * `public/assets/config/app-config.json` is deep-merged OVER DEFAULT_APP_CONFIG
 * at startup, so any stale string in the JSON's `copy` subtree silently wins
 * over the corrected default. That is how the "No registration required"
 * landing copy and the magic-link how-it-works copy survived PR #239 — the
 * PR fixed `app-config.defaults.ts` but the served JSON still carried the old
 * wording, and the JSON wins.
 *
 * Invariant: every copy string present in the served JSON must equal the
 * compiled default. The JSON may omit keys (the default then applies) and may
 * carry extra inert keys, but it must never override a default with a stale
 * value. When legitimate per-environment copy is ever needed, extend this
 * spec with an explicit allowlist — do not let the trees drift silently.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from './app-config.defaults';

const here = dirname(fileURLToPath(import.meta.url));
// apps/web/src/app/core/config -> apps/web/public/assets/config/app-config.json
const SERVED_CONFIG = join(here, '..', '..', '..', '..', 'public', 'assets', 'config', 'app-config.json');

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function collectStrings(node: Json, path: string, out: Map<string, string>): void {
  if (typeof node === 'string') {
    out.set(path, node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectStrings(item, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      collectStrings(v, path ? `${path}.${k}` : k, out);
    }
  }
}

describe('served app-config.json copy drift', () => {
  it('every copy string in the served JSON matches the compiled default', () => {
    const served = JSON.parse(readFileSync(SERVED_CONFIG, 'utf8')) as { copy: Json };
    const servedStrings = new Map<string, string>();
    const defaultStrings = new Map<string, string>();
    collectStrings(served.copy, 'copy', servedStrings);
    collectStrings(DEFAULT_APP_CONFIG.copy as unknown as Json, 'copy', defaultStrings);

    /**
     * Explicit allowlist (auth/05, 2026-09-28). `copy.builder.entra` carries
     * per-environment Entra identifiers (tenant subdomain/ID, client ID,
     * user flow) — deployment config, not copy. The served JSON must carry
     * the real values while the compiled defaults keep the `ENTRA_*`
     * placeholders (the frontend's `isConfigured()` treats any placeholder
     * as "not configured"). This is the same reason the admin values live
     * outside `copy` at top-level `admin.entra`.
     */
    const ALLOWLISTED_PREFIXES = ['copy.builder.entra.'];
    const isAllowlisted = (path: string) =>
      ALLOWLISTED_PREFIXES.some((prefix) => path.startsWith(prefix));

    const stale: string[] = [];
    for (const [path, servedValue] of servedStrings) {
      if (isAllowlisted(path)) continue;
      const defaultValue = defaultStrings.get(path);
      if (defaultValue !== undefined && defaultValue !== servedValue) {
        stale.push(`${path}\n    served:  ${JSON.stringify(servedValue).slice(0, 120)}\n    default: ${JSON.stringify(defaultValue).slice(0, 120)}`);
      }
    }
    expect(
      stale,
      `Stale copy overrides in public/assets/config/app-config.json — sync them to app-config.defaults.ts:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('served copy.builder.entra carries real (non-placeholder) identifiers', () => {
    // auth/05: the deployed JSON is what flips /builder/login from the
    // "not configured" line to the sign-in button. If any value here is a
    // placeholder, BuilderEntraAuthService.isConfigured() returns false.
    const served = JSON.parse(readFileSync(SERVED_CONFIG, 'utf8')) as {
      copy: { builder?: { entra?: Record<string, Json> } };
    };
    const entra = served.copy.builder?.entra;
    expect(entra).toBeDefined();
    for (const key of ['tenantSubdomain', 'tenantId', 'clientId', 'userFlow']) {
      const value = entra?.[key];
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
      expect((value as string).startsWith('ENTRA_')).toBe(false);
    }
  });
});
