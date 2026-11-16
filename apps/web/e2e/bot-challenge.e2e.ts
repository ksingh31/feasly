/**
 * #905: the invisible bot challenge (API half #788) in a real browser.
 *
 * 1. Normal path: the gate (preview + lead) never loads Turnstile — no
 *    request to challenges.cloudflare.com, no script tag, no token header.
 * 2. Challenge path: the preview and lead POSTs each answer 403
 *    CHALLENGE_REQUIRED once; the app loads Turnstile on demand with the
 *    site key from the 403 body, retries each request once with the
 *    `X-Turnstile-Token` header, and the gate completes. Desktop 1440×900
 *    and phone 390×844: no horizontal overflow, axe zero critical/serious.
 * 3. Challenge fails: the original 403 message shows in the existing error
 *    state, with no second retry.
 *
 * Pages are served with the production CSP from staticwebapp.config.json
 * (serve-dist sends none), so the CSP allowance for the Turnstile origin is
 * exercised too. Turnstile itself is a local stub (no network in CI).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Request, Route } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AutocompleteResponse, LeadResponse, PreviewEstimateResponse, PropertyRecord } from '@feasly/contracts';

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '390', width: 390, height: 844 },
] as const;

const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');
const takeScreenshots = process.env['E2E_SCREENSHOTS'] === '1';

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const SITE_KEY = 'e2e-site-key-from-403';
const TOKEN = 'e2e-turnstile-token';
const TOKEN_HEADER = 'x-turnstile-token';
const CHALLENGE_MESSAGE = 'Please confirm you are not a bot, then try again.';

const swaConfig = JSON.parse(
  readFileSync(join(__dirname, '..', 'public', 'staticwebapp.config.json'), 'utf8'),
) as { globalHeaders: Record<string, string> };
const CSP = swaConfig.globalHeaders['Content-Security-Policy'] ?? '';

const PROPERTY: PropertyRecord = {
  addressKey: 'calgary-1234-14-st-nw',
  address: '1234 14 St NW, Calgary, AB',
  community: 'Capitol Hill',
  lotSqft: 5000,
  zoning: 'R-C1',
  assessedValue: 729000,
  assessmentYear: 2025,
  yearBuilt: 1978,
  assessmentClass: 'R',
  isNonResidential: false,
  dataAsOf: '2025-07-01',
  stale: false,
};

const AUTOCOMPLETE: AutocompleteResponse = {
  suggestions: [{ addressKey: PROPERTY.addressKey, address: PROPERTY.address, community: PROPERTY.community }],
};

const PREVIEW = {
  estimateId: 'est-e2e-1',
  addressKey: PROPERTY.addressKey,
  inputs: { sqft: 2200, tier: 'standard' },
  figures: {
    build: { low: 700_000, base: 800_000, high: 900_000 },
    total: { low: 1_400_000, base: 1_500_000, high: 1_600_000 },
    land: { value: 729_000 },
  },
  rows: [],
  costDataVersion: 'e2e',
  createdAt: '2026-11-16T00:00:00.000Z',
} as unknown as PreviewEstimateResponse;

const LEAD = { leadId: 'lead-e2e-1', magicLinkSent: true, expiresInDays: 7 } as LeadResponse;

const CHALLENGE_403 = {
  code: 'CHALLENGE_REQUIRED',
  message: CHALLENGE_MESSAGE,
  retryable: false,
  challenge: { provider: 'turnstile', siteKey: SITE_KEY },
};

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Stub Turnstile: renders nothing and answers like the managed widget. */
function turnstileStub(mode: 'pass' | 'fail'): string {
  return `window.turnstile = {
    render: function (el, o) {
      window.__turnstileSiteKey = o.sitekey;
      window.__turnstileAppearance = o.appearance;
      setTimeout(function () { ${mode === 'pass' ? `o.callback(${JSON.stringify(TOKEN)})` : "o['error-callback']()"}; }, 50);
      return 'w1';
    },
    remove: function () {}
  };`;
}

interface Mock {
  readonly previews: Request[];
  readonly leads: Request[];
  readonly turnstileRequests: string[];
}

async function mockApi(
  page: Page,
  opts: { challenge: boolean; turnstile: 'pass' | 'fail' },
): Promise<Mock> {
  const mock: Mock = { previews: [], leads: [], turnstileRequests: [] };
  await page.addInitScript(() => {
    window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
  });
  // Production CSP on every page load.
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': CSP } });
  });
  await page.route('**/assets/config/app-config.json', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, Record<string, unknown>>;
    config['propertyData'] = { ...config['propertyData'], source: 'backend' };
    config['api'] = { ...config['api'], useMockApi: false };
    await json(route, config);
  });
  await page.route(`${TURNSTILE_ORIGIN}/**`, (route) => {
    mock.turnstileRequests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: turnstileStub(opts.turnstile) });
  });
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/v1/properties/autocomplete') return json(route, AUTOCOMPLETE);
    if (path === '/api/v1/properties/lookup') return json(route, PROPERTY);
    if (path === '/api/v1/events') return route.fulfill({ status: 204 });
    if (path === '/api/v1/estimates/preview' && req.method() === 'POST') {
      mock.previews.push(req);
      const challenged = opts.challenge && req.headers()[TOKEN_HEADER] !== TOKEN;
      return challenged ? json(route, CHALLENGE_403, 403) : json(route, PREVIEW);
    }
    if (path === '/api/v1/leads' && req.method() === 'POST') {
      mock.leads.push(req);
      const challenged = opts.challenge && req.headers()[TOKEN_HEADER] !== TOKEN;
      return challenged ? json(route, CHALLENGE_403, 403) : json(route, LEAD);
    }
    return json(route, { code: 'NOT_FOUND', message: 'No e2e fixture.' }, 404);
  });
  return mock;
}

/** Landing → pick the address → gate, then submit the gate form. */
async function submitGate(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.hero-title')).toBeVisible();
  await page.getByRole('combobox').first().fill('1234 14 St');
  await page.getByRole('option').first().click();
  await expect(page).toHaveURL(/\/estimate\/scope$/);
  await page.goto('/estimate/gate');
  await page.locator('#gate-name').fill('Jane Doe');
  await page.locator('#gate-email').fill('jane@example.com');
  await page.locator('#gate-timeline').selectOption({ index: 1 });
  await page.locator('.consent input').check();
  await page.locator('#gate-name').press('Enter');
}

async function assertNoOverflowAndA11y(page: Page, shotName: string): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = axe.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(serious, 'axe critical/serious violations').toEqual([]);
  if (takeScreenshots) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SCREENSHOT_DIR, `${shotName}.png`), fullPage: true, animations: 'disabled' });
  }
}

test.describe('invisible bot challenge (#905)', () => {
  test('normal path never loads Turnstile', async ({ page }) => {
    const cspErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && msg.text().includes('Content Security Policy')) cspErrors.push(msg.text());
    });
    const mock = await mockApi(page, { challenge: false, turnstile: 'pass' });
    await submitGate(page);
    await expect.poll(() => mock.leads.length, { timeout: 10_000 }).toBe(1);
    await expect(page).not.toHaveURL(/\/estimate\/gate$/);
    expect(mock.turnstileRequests).toEqual([]);
    expect(await page.locator(`script[src^="${TURNSTILE_ORIGIN}"]`).count()).toBe(0);
    for (const req of [...mock.previews, ...mock.leads]) {
      expect(req.headers()[TOKEN_HEADER]).toBeUndefined();
    }
    expect(cspErrors).toEqual([]);
  });

  for (const viewport of VIEWPORTS) {
    test(`challenge 403 on preview + lead: one invisible retry each, gate completes @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const cspErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error' && msg.text().includes('Content Security Policy')) cspErrors.push(msg.text());
      });
      const mock = await mockApi(page, { challenge: true, turnstile: 'pass' });
      await submitGate(page);
      await expect.poll(() => mock.leads.length, { timeout: 15_000 }).toBe(2);
      await expect(page).not.toHaveURL(/\/estimate\/gate$/, { timeout: 10_000 });

      // Estimate flow: challenged once, retried once with the token.
      expect(mock.previews.map((r) => r.headers()[TOKEN_HEADER])).toEqual([undefined, TOKEN]);
      // Gate flow: same.
      expect(mock.leads.map((r) => r.headers()[TOKEN_HEADER])).toEqual([undefined, TOKEN]);
      // The script loaded once, on demand, with the site key from the 403.
      expect(mock.turnstileRequests).toHaveLength(1);
      expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)['__turnstileSiteKey'])).toBe(SITE_KEY);
      expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)['__turnstileAppearance'])).toBe(
        'interaction-only',
      );
      // The widget host is cleaned up after each solve.
      expect(await page.locator('.feasly-turnstile-host').count()).toBe(0);
      expect(cspErrors).toEqual([]);
      await assertNoOverflowAndA11y(page, `bot-challenge-recovered-${viewport.label}`);
    });
  }

  for (const viewport of VIEWPORTS) {
    test(`challenge cannot complete: honest error, no retry @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const mock = await mockApi(page, { challenge: true, turnstile: 'fail' });
      await submitGate(page);
      const error = page.locator('.form-error[role="alert"]');
      await expect(error).toBeVisible({ timeout: 10_000 });
      await expect(page).toHaveURL(/\/estimate\/gate$/);
      expect(mock.previews).toHaveLength(1);
      expect(mock.leads).toHaveLength(0);
      expect(await page.locator('.feasly-turnstile-host').count()).toBe(0);
      await assertNoOverflowAndA11y(page, `bot-challenge-failed-${viewport.label}`);
    });
  }
});
