/**
 * #692: estimator deep link `/?address=<text>&src=<source>` in a real
 * browser, against the prerendered production build (the static `/` HTML is
 * served first and the link is read after hydration — AC5).
 *
 * The served config is patched to the `backend` property source so lookups
 * go to `/api/v1/properties/*`, answered here by contract-shaped fixtures.
 * Desktop 1440×900 and phone 390×844: no horizontal overflow, axe zero
 * critical/serious on the prefilled picker.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AutocompleteResponse, PropertyRecord } from '@feasly/contracts';

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '390', width: 390, height: 844 },
] as const;

const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');
const takeScreenshots = process.env['E2E_SCREENSHOTS'] === '1';

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

const SINGLE: AutocompleteResponse = {
  suggestions: [{ addressKey: PROPERTY.addressKey, address: PROPERTY.address, community: PROPERTY.community }],
};

const SEVERAL: AutocompleteResponse = {
  suggestions: [
    { addressKey: 'calgary-1-14-st-nw', address: '1 14 St NW, Calgary, AB', community: 'Hillhurst' },
    { addressKey: 'calgary-10-14-st-nw', address: '10 14 St NW, Calgary, AB', community: 'Hillhurst' },
    { addressKey: 'calgary-100-14-st-nw', address: '100 14 St NW, Calgary, AB', community: 'Hillhurst' },
  ],
};

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface Mock {
  readonly autocompleteQueries: string[];
}

async function mockSite(page: Page, autocomplete: (q: string) => AutocompleteResponse): Promise<Mock> {
  const mock: Mock = { autocompleteQueries: [] };
  // Returning visitor who already answered the analytics prompt: keeps the
  // fixed consent banner out of the way.
  await page.addInitScript(() => {
    window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
  });
  await page.route('**/assets/config/app-config.json', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, Record<string, unknown>>;
    config['propertyData'] = { ...config['propertyData'], source: 'backend' };
    await json(route, config);
  });
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/properties/autocomplete') {
      const q = url.searchParams.get('q') ?? '';
      mock.autocompleteQueries.push(q);
      return json(route, autocomplete(q));
    }
    if (url.pathname === '/api/v1/properties/lookup') {
      return json(route, PROPERTY);
    }
    return json(route, { error: { code: 'NOT_FOUND', message: 'No e2e fixture.' } }, 404);
  });
  return mock;
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
    await page.screenshot({ path: join(SCREENSHOT_DIR, `${shotName}.png`) });
  }
}

test.describe('estimator deep link (#692)', () => {
  for (const viewport of VIEWPORTS) {
    test.describe(`@ ${viewport.label}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
      });

      test('single match lands on the scope step with the property loaded (AC1)', async ({ page }) => {
        const mock = await mockSite(page, () => SINGLE);
        await page.goto('/?address=1234%2014%20St%20NW&src=community-lots');
        await expect(page).toHaveURL(/\/estimate\/scope$/);
        await expect(page.locator('h1.scope-heading')).toBeVisible();
        await expect(page.getByText('1234 14 St NW', { exact: false }).first()).toBeVisible();
        expect(mock.autocompleteQueries).toEqual(['1234 14 St NW']);
        const wizard = await page.evaluate(() => JSON.parse(window.localStorage.getItem('wizard') ?? '{}'));
        expect(wizard.property?.addressKey).toBe(PROPERTY.addressKey);
        expect(wizard.entrySource).toBe('community-lots');
        await assertNoOverflowAndA11y(page, `deep-link-scope-${viewport.label}`);

        // Back returns to a plain landing page; the lookup does not re-run.
        await page.goBack();
        await expect(page.locator('.hero-title')).toBeVisible();
        expect(page.url()).not.toContain('address=');
        expect(mock.autocompleteQueries).toHaveLength(1);
      });

      test('several matches show the picker with the query prefilled; page is noindex (AC2, AC4)', async ({ page }) => {
        await mockSite(page, () => SEVERAL);
        await page.goto('/?address=14%20St%20NW&src=not-on-the-list');
        await expect(page.getByRole('option')).toHaveCount(3);
        await expect(page.getByRole('combobox')).toHaveValue('14 St NW');
        await expect(page).toHaveURL(/\/$/);
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow');
        const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
        expect(canonical).toMatch(/\/$/);
        const wizard = await page.evaluate(() => JSON.parse(window.localStorage.getItem('wizard') ?? '{}'));
        expect(wizard.entrySource ?? null).toBeNull();
        // Still open well past the autocomplete debounce (#692 QA: it used to close).
        await expect(page.getByRole('option')).toHaveCount(3);
        await assertNoOverflowAndA11y(page, `deep-link-picker-${viewport.label}`);
      });

      test('an over-long parameter is ignored: plain landing page, no lookup (AC3)', async ({ page }) => {
        const mock = await mockSite(page, () => SINGLE);
        await page.goto(`/?address=${'9'.repeat(400)}`);
        await expect(page.locator('.hero-title')).toBeVisible();
        await expect(page.getByRole('combobox')).toHaveValue('');
        expect(mock.autocompleteQueries).toEqual([]);
      });
    });
  }
});
