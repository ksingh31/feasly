/**
 * #831 spec: the public status page config (infra/status-page/.upptimerc.yml).
 *
 * Upptime runs in a separate public repo, so nothing in this repo executes the
 * file. This spec keeps it honest: it monitors the site, API health and the
 * embed every 5 minutes, its URLs match the repo's health checks
 * (infra/health/checks.sh), incidents get assignees (Upptime opens an issue per
 * outage), and the footer's configured status URL points at the same page.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RC = readFileSync(join(ROOT, 'infra', 'status-page', '.upptimerc.yml'), 'utf8');
const CHECKS = readFileSync(join(ROOT, 'infra', 'health', 'checks.sh'), 'utf8');
const APP_CONFIG = JSON.parse(
  readFileSync(join(ROOT, 'apps', 'web', 'public', 'assets', 'config', 'app-config.json'), 'utf8'),
) as { site: { statusPageUrl: string } };

/** Top-level scalar `key: value` (unquoted), or undefined. */
function scalar(key: string, text = RC): string | undefined {
  return new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm').exec(text)?.[1];
}

/** `- name: X` / `url: Y` pairs under `sites:`. */
function sites(): Map<string, string> {
  const block = /^sites:\n([\s\S]*?)^\S/m.exec(RC)?.[1] ?? '';
  const out = new Map<string, string>();
  for (const m of block.matchAll(/^\s*- name:\s*(.+)\n\s*url:\s*(\S+)/gm)) out.set(m[1].trim(), m[2]);
  return out;
}

function checksDefault(name: string): string {
  const v = new RegExp(`^${name}="\\$\\{${name}:-([^}]+)\\}"`, 'm').exec(CHECKS)?.[1];
  if (!v) throw new Error(`${name} default not found in infra/health/checks.sh`);
  return v;
}

describe('status page (Upptime) config', () => {
  const owner = scalar('owner');
  const repo = scalar('repo');

  it('names the public status repo', () => {
    expect(owner).toMatch(/^[\w-]+$/);
    expect(repo).toBe('feasly-status');
  });

  it('monitors the site, API health and embed at the health-check URLs', () => {
    const site = checksDefault('SITE_URL');
    const api = checksDefault('API_URL');
    expect(Object.fromEntries(sites())).toEqual({
      Site: `${site}/`,
      API: `${api}/api/health`,
      Embed: `${site}/embed/v1/loader.js`,
    });
  });

  it('flags a degraded database and a missing embed loader', () => {
    expect(RC).toMatch(/url: \S+\/api\/health\n\s*__dangerous__body_degraded: degraded/);
    expect(RC).toMatch(/loader\.js\n\s*__dangerous__body_down_if_text_missing: Feasly embed loader/);
    // The loader banner the check looks for really ships in the loader source.
    const loader = readFileSync(join(ROOT, 'apps', 'web', 'snippet', 'loader.js'), 'utf8');
    expect(loader).toContain('Feasly embed loader');
  });

  it('checks every 5 minutes', () => {
    expect(RC).toMatch(/^workflowSchedule:\n(?:\s+.+\n)*?\s+uptime: "\*\/5 \* \* \* \*"/m);
  });

  it('assigns incident issues to someone', () => {
    expect(RC).toMatch(/^assignees:\n\s+- [\w-]+/m);
  });

  it('serves the page from the repo GitHub Pages path, matching the footer URL', () => {
    expect(RC).toMatch(new RegExp(`^\\s+baseUrl: /${repo}$`, 'm'));
    const footer = APP_CONFIG.site.statusPageUrl;
    // Empty = link hidden until the status repo is live (docs/ops/status-page.md).
    if (footer !== '') expect(footer).toBe(`https://${owner}.github.io/${repo}/`);
  });
});
