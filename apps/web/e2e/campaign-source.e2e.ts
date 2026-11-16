/**
 * #815: campaign attribution and the admin funnel in a real browser.
 *
 * 1. A visitor who accepted analytics lands on `/?utm_source=google&utm_campaign=test&gclid=…`,
 *    picks an address and completes the gate. The lead POST carries those
 *    utm values and the click-id *type* (never the click id itself), and
 *    so does every analytics event.
 * 2. The same visit with analytics declined makes zero analytics calls and
 *    sends no source on the lead.
 * 3. Admin lead detail shows the lead's campaign fields; the admin funnel
 *    shows the source/campaign filters and the per-campaign table. Desktop
 *    1440×900 and phone 390×844: no horizontal overflow, axe zero
 *    critical/serious.
 *
 * The API is answered by contract-shaped fixtures (no Functions host).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AnalyticsEvent,
  AutocompleteResponse,
  LeadRequest,
  LeadResponse,
  PreviewEstimateResponse,
  PropertyRecord,
} from '@feasly/contracts';
import { mockAdminApi } from './admin-api-fixtures';

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '390', width: 390, height: 844 },
] as const;

const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');
const takeScreenshots = process.env['E2E_SCREENSHOTS'] === '1';

const CLICK_ID = 'Cj0KCQ-e2e-click-id';
const LANDING = `/?utm_source=google&utm_campaign=test&gclid=${CLICK_ID}`;

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

const PREVIEW: PreviewEstimateResponse = {
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

const LEAD: LeadResponse = { leadId: 'lead-e2e-1', magicLinkSent: true, expiresInDays: 7 } as LeadResponse;

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface ConsumerMock {
  readonly events: AnalyticsEvent[];
  readonly leads: LeadRequest[];
}

async function mockConsumer(page: Page, consent: 'granted' | 'declined'): Promise<ConsumerMock> {
  const mock: ConsumerMock = { events: [], leads: [] };
  await page.addInitScript((status) => {
    window.localStorage.setItem('consent', JSON.stringify({ status, consentTs: '2026-11-01T00:00:00.000Z' }));
  }, consent);
  await page.route('**/assets/config/app-config.json', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, Record<string, unknown>>;
    config['propertyData'] = { ...config['propertyData'], source: 'backend' };
    config['api'] = { ...config['api'], useMockApi: false };
    await json(route, config);
  });
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/v1/properties/autocomplete') return json(route, AUTOCOMPLETE);
    if (path === '/api/v1/properties/lookup') return json(route, PROPERTY);
    if (path === '/api/v1/events') {
      mock.events.push(req.postDataJSON() as AnalyticsEvent);
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/v1/estimates/preview') return json(route, PREVIEW);
    if (path === '/api/v1/leads' && req.method() === 'POST') {
      mock.leads.push(req.postDataJSON() as LeadRequest);
      return json(route, LEAD);
    }
    return json(route, { code: 'NOT_FOUND', message: 'No e2e fixture.' }, 404);
  });
  return mock;
}

/** Landing → pick the address → scope → gate, then submit the gate form. */
async function completeGate(page: Page): Promise<void> {
  await page.goto(LANDING);
  await expect(page.locator('.hero-title')).toBeVisible();
  await page.getByRole('combobox').first().fill('1234 14 St');
  await page.getByRole('option').first().click();
  await expect(page).toHaveURL(/\/estimate\/scope$/);
  // A full reload: the wizard persists in localStorage and the campaign
  // source in sessionStorage, so first-touch attribution survives it.
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

test.describe('campaign attribution (#815)', () => {
  test('utm landing → gate: the lead and every event carry the source (AC1)', async ({ page }) => {
    const mock = await mockConsumer(page, 'granted');
    await completeGate(page);
    await expect.poll(() => mock.leads.length, { timeout: 10_000 }).toBe(1);
    expect(mock.leads[0]!.source).toEqual({ utm_source: 'google', utm_campaign: 'test', click_id_type: 'gclid' });

    const names = mock.events.map((e) => e.event);
    expect(names).toContain('landing_view');
    expect(names).toContain('address_search');
    expect(names).toContain('address_selected');
    expect(names).toContain('gate_view');
    expect(names.filter((n) => n === 'landing_view')).toHaveLength(1);
    expect(names.filter((n) => n === 'address_selected')).toHaveLength(1);
    for (const event of mock.events) {
      expect(event.source).toEqual({ utm_source: 'google', utm_campaign: 'test', click_id_type: 'gclid' });
    }
    // The click id value never leaves the browser.
    expect(JSON.stringify([mock.leads, mock.events])).not.toContain(CLICK_ID);
  });

  test('declined analytics: zero analytics calls and no source on the lead (AC2)', async ({ page }) => {
    const mock = await mockConsumer(page, 'declined');
    await completeGate(page);
    await expect.poll(() => mock.leads.length, { timeout: 10_000 }).toBe(1);
    expect(mock.leads[0]!.source).toBeUndefined();
    expect(mock.events).toEqual([]);
  });

  for (const viewport of VIEWPORTS) {
    test(`admin lead detail shows the campaign fields @ ${viewport.label} (AC1)`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript(() => {
        window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
      });
      await mockAdminApi(page, { signedIn: true });
      await page.goto('/admin/leads?open=lead-1');
      const drawer = page.locator('[role="dialog"]:visible').first();
      const campaign = drawer.locator('.lead-drawer__attribution');
      await expect(campaign).toBeVisible();
      await expect(campaign).toContainText('google');
      await expect(campaign).toContainText('test');
      await expect(campaign).toContainText('gclid');
      await campaign.scrollIntoViewIfNeeded();
      await assertNoOverflowAndA11y(page, `admin-lead-campaign-${viewport.label}`);
    });

    test(`admin funnel: new steps, source filters and campaign table @ ${viewport.label} (AC3)`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript(() => {
        window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
      });
      await mockAdminApi(page, { signedIn: true });
      const funnelQueries: URLSearchParams[] = [];
      page.on('request', (req) => {
        const url = new URL(req.url());
        if (url.pathname === '/api/v1/admin/funnels') funnelQueries.push(url.searchParams);
      });
      await page.goto('/admin/funnels');
      await expect(page.locator('.funnels__step-label').first()).toHaveText('Landing view');
      await expect(page.locator('.funnels__sources-table tbody tr')).toHaveCount(3);
      await assertNoOverflowAndA11y(page, `admin-funnel-sources-${viewport.label}`);

      await page.locator('.funnels__utm-source input').fill('google');
      await page.locator('.funnels__utm-campaign input').fill('test');
      await page.locator('.funnels__apply').click();
      await expect.poll(() => funnelQueries.at(-1)?.get('utm_source')).toBe('google');
      expect(funnelQueries.at(-1)?.get('utm_campaign')).toBe('test');
    });
  }
});
