/**
 * #752: every visitor-facing property read goes through our API.
 *
 * Runs against the production build with the SERVED config untouched (no
 * propertyData patch, unlike deep-link.e2e.ts): typing an address and
 * picking it must call `/api/v1/properties/*` and never `data.calgary.ca`
 * (AC1). A roll value like `R-C2,R-CG` is replaced by the current district
 * the API returns (#686) in the property card (AC3). With the API down, the
 * existing error state shows and nothing falls back to the City API (AC5).
 * Desktop 1440×900 and phone 390×844 (AC6): no horizontal overflow, axe
 * zero critical/serious.
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

/** A parcel the 2026 roll lists as `R-C2,R-CG`; the API returns its current district. */
const PROPERTY: PropertyRecord = {
  addressKey: '16 DEERMEADE BA SE',
  address: '16 Deermeade Ba SE, Calgary, AB',
  community: 'Deer Ridge',
  lotSqft: 5200,
  zoning: 'R-C2',
  assessedValue: 610000,
  assessmentYear: 2026,
  assessmentYearInferred: false,
  yearBuilt: 1979,
  assessmentClass: 'RE',
  isNonResidential: false,
  dataAsOf: '2026-01-14',
  stale: false,
  landUse: {
    district: 'R-C2',
    description: 'Residential - Contextual One / Two Dwelling',
    source: 'land-use-districts',
    asOf: '2026-11-15',
  },
};

const SUGGESTIONS: AutocompleteResponse = {
  suggestions: [
    { addressKey: PROPERTY.addressKey, address: PROPERTY.address, community: PROPERTY.community },
    { addressKey: '16 DEERMOSS CR SE', address: '16 Deermoss Cr SE, Calgary, AB', community: 'Deer Run' },
  ],
};

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface Traffic {
  readonly propertyPaths: string[];
  readonly cityRequests: string[];
}

async function mockSite(page: Page, apiDown: boolean): Promise<Traffic> {
  const traffic: Traffic = { propertyPaths: [], cityRequests: [] };
  await page.addInitScript(() => {
    window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
  });
  // Any browser call to the City's open-data host is recorded and refused.
  await page.route('**://data.calgary.ca/**', (route) => {
    traffic.cityRequests.push(route.request().url());
    return route.abort();
  });
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/v1/properties/')) {
      traffic.propertyPaths.push(url.pathname);
      if (apiDown) {
        return json(
          route,
          { code: 'DEPENDENCY_UNAVAILABLE', message: 'City data is temporarily unavailable.', retryable: true },
          503,
        );
      }
      if (url.pathname === '/api/v1/properties/autocomplete') return json(route, SUGGESTIONS);
      if (url.pathname === '/api/v1/properties/lookup') return json(route, PROPERTY);
    }
    return json(route, { code: 'NOT_FOUND', message: 'No e2e fixture.' }, 404);
  });
  return traffic;
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

test.describe('property data comes from our API (#752)', () => {
  for (const viewport of VIEWPORTS) {
    test.describe(`@ ${viewport.label}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
      });

      test('typing and picking an address calls /api/v1/properties/* only; card shows the current district (AC1, AC3)', async ({ page }) => {
        const traffic = await mockSite(page, false);
        await page.goto('/');
        await page.getByRole('combobox').pressSequentially('16 Deerm');
        await expect(page.getByRole('option')).toHaveCount(2);
        await assertNoOverflowAndA11y(page, `property-source-picker-${viewport.label}`);
        await page.getByRole('option', { name: /16 Deermeade/ }).click();

        await expect(page).toHaveURL(/\/estimate\/scope$/);
        const card = page.locator('app-property-card');
        await expect(card.getByText('R-C2', { exact: true })).toBeVisible();
        await expect(card.getByText('R-CG')).toHaveCount(0);

        expect(traffic.propertyPaths).toContain('/api/v1/properties/autocomplete');
        expect(traffic.propertyPaths).toContain('/api/v1/properties/lookup');
        expect(traffic.cityRequests).toEqual([]);
        await assertNoOverflowAndA11y(page, `property-source-scope-${viewport.label}`);
      });

      test('API unavailable shows the error state with no fallback to the City (AC5)', async ({ page }) => {
        const traffic = await mockSite(page, true);
        await page.goto('/');
        await page.getByRole('combobox').pressSequentially('16 Deerm');
        const error = page.locator('.ac-error');
        await expect(error).toBeVisible();
        await expect(error.getByRole('button')).toBeVisible();
        await expect(page.getByRole('option')).toHaveCount(0);

        expect(traffic.propertyPaths.length).toBeGreaterThan(0);
        expect(traffic.cityRequests).toEqual([]);
        await assertNoOverflowAndA11y(page, `property-source-error-${viewport.label}`);
      });
    });
  }
});
