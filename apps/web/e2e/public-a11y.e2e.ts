/**
 * #832: WCAG 2.2 AA sweep of every public route and the consumer flow.
 *
 * For each route in PUBLIC_A11Y_ROUTES at 1440×900, 390×844 and 375×667
 * (the small-iPhone width), on Chromium and WebKit (the Safari engine):
 *   - axe (WCAG 2.0/2.1/2.2 A + AA tags) reports zero critical/serious,
 *   - no horizontal overflow.
 * The consumer flow (landing → scope → preview/gate → report) is driven on
 * the contract-shaped mock API (`api.useMockApi`, `propertyData.source:
 * 'mock'`) and each step gets the same checks plus a screenshot when
 * E2E_SCREENSHOTS=1 (PR evidence for the iPhone Safari pass).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EmbedPublicConfig } from '@feasly/contracts';
import { PUBLIC_A11Y_ROUTES } from './public-a11y-routes';

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '390', width: 390, height: 844 },
  { label: '375', width: 375, height: 667 },
] as const;

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');
const takeScreenshots = process.env['E2E_SCREENSHOTS'] === '1';

/** Contract-shaped tenant config for the embed routes (pilot-like accent). */
const EMBED_CONFIG: EmbedPublicConfig = {
  business_name: 'E2E Builders Ltd.',
  display_name: 'E2E Builders',
  logo_url: '',
  accent_color: '#1f4e79',
  allowed_origins: ['http://localhost:4280'],
  fallback_phone: '403-555-0100',
  fallback_email: 'hello@example.com',
  plan: null,
};

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * Mock API + mock property data. By default a returning visitor (consent
 * answered, so the fixed banner is out of the way); `firstVisit` keeps the
 * banner up.
 */
async function mockSite(page: Page, opts: { firstVisit?: boolean } = {}): Promise<void> {
  if (!opts.firstVisit) {
    await page.addInitScript(() => {
      window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
    });
  }
  await page.route('**/assets/config/app-config.json', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, Record<string, unknown>>;
    config['api'] = { ...config['api'], useMockApi: true };
    config['propertyData'] = { ...config['propertyData'], source: 'mock' };
    config['timings'] = { ...config['timings'], mockLatencyMinMs: 0, mockLatencyMaxMs: 0 };
    await json(route, config);
  });
  // Nothing may reach a real backend from this suite. The embed shell reads
  // its tenant config over HTTP even in mock mode.
  await page.route('**/api/**', (route) => {
    if (new URL(route.request().url()).pathname === '/api/v1/embed/config') return json(route, EMBED_CONFIG);
    return json(route, { error: { code: 'NOT_FOUND', message: 'No e2e fixture.' } }, 404);
  });
}

async function assertA11y(page: Page, shotName: string, fullPage = true): Promise<void> {
  // The client app re-renders over the prerendered HTML once its config has
  // loaded (no hydration); scanning mid-swap reports detached, nameless nodes.
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, 'horizontal overflow').toBeLessThanOrEqual(innerWidth);
  const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const serious = axe.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(serious, 'axe critical/serious violations').toEqual([]);
  if (takeScreenshots) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    // WebKit full-page captures redraw fixed elements (nav, skip link)
    // mid-page; capture what the phone screen shows instead.
    const isWebKit = page.context().browser()?.browserType().name() === 'webkit';
    await page.screenshot({ path: join(SCREENSHOT_DIR, `${shotName}.png`), fullPage: fullPage && !isWebKit });
  }
}

test.describe('public routes: WCAG 2.2 AA (#832)', () => {
  for (const viewport of VIEWPORTS) {
    for (const route of PUBLIC_A11Y_ROUTES) {
      test(`${route.url} @ ${viewport.label}`, async ({ page, browserName }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await mockSite(page);
        await page.goto(route.url);
        await expect(page.locator(route.ready).first()).toBeVisible();
        await assertA11y(page, `public-${route.name}-${viewport.label}-${browserName}`);
      });
    }
  }
});

/**
 * Type into the address box once the page has hydrated: a value typed into
 * the prerendered input before hydration is discarded, so retry until the
 * suggestions show.
 */
async function typeAddress(page: Page): Promise<void> {
  await expect(async () => {
    await page.getByRole('combobox').fill('');
    await page.getByRole('combobox').fill('1234 14');
    await expect(page.getByRole('option').first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

/** Landing → pick the first mock address → scope step. */
async function toScope(page: Page): Promise<void> {
  await page.goto('/');
  await typeAddress(page);
  await page.getByRole('option').first().click();
  await expect(page).toHaveURL(/\/estimate\/scope$/);
  await expect(page.locator('h1.scope-heading')).toBeVisible();
}

async function toPreview(page: Page): Promise<void> {
  await toScope(page);
  await page.getByRole('radio').first().click();
  await page.locator('button.cta').click();
  await expect(page).toHaveURL(/\/estimate\/preview$/);
  await expect(page.locator('a.cta.unlock')).toBeVisible();
}

async function fillGate(page: Page): Promise<void> {
  await page.locator('#gate-name, input[formcontrolname="name"]').first().fill('Test Person');
  await page.locator('input[formcontrolname="email"]').fill('test@example.com');
  await page.locator('input[formcontrolname="phone"]').fill('4035551234');
  await page.locator('select[formcontrolname="timeline"]').selectOption({ index: 1 });
  await page.locator('input[formcontrolname="consent"]').check();
}

/**
 * The focused control is not hidden under a sticky/fixed element
 * (WCAG 2.2 SC 2.4.11 Focus Not Obscured): the topmost element at the
 * control's centre is the control itself (or inside it / its label).
 */
async function expectFocusNotObscured(page: Page): Promise<void> {
  const obscuredBy = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || el.contains(top) || top.contains(el) || top.closest('label')?.contains(el)) return null;
    return `${el.tagName}#${el.id} covered by ${top.tagName}.${String(top.className)}`;
  });
  expect(obscuredBy, 'focused control obscured').toBeNull();
}

test.describe('consumer flow: WCAG 2.2 AA + iPhone Safari (#832)', () => {
  for (const viewport of VIEWPORTS) {
    test(`landing → scope → preview → gate → report @ ${viewport.label}`, async ({ page, browserName }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockSite(page);
      const shot = (step: string): string => `flow-${step}-${viewport.label}-${browserName}`;

      await page.goto('/');
      await typeAddress(page);
      await assertA11y(page, shot('1-landing-autocomplete'), false);
      await page.getByRole('option').first().click();
      await expect(page.locator('h1.scope-heading')).toBeVisible();
      await assertA11y(page, shot('2-scope'));

      await page.getByRole('radio').first().click();
      await assertA11y(page, shot('3-scope-selected'));
      await page.locator('button.cta').click();
      await expect(page.locator('a.cta.unlock')).toBeVisible();
      await assertA11y(page, shot('4-preview'));

      await page.locator('a.cta.unlock').click();
      await expect(page.locator('h1.gate-heading')).toBeVisible();
      await assertA11y(page, shot('5-gate'));
      // Submitting empty shows the inline errors — those must pass too.
      await page.locator('button.cta[type="submit"]').click();
      await assertA11y(page, shot('6-gate-errors'));
      await fillGate(page);
      await page.locator('button.cta[type="submit"]').click();
      await expect(page).toHaveURL(/\/estimate\/report$/);
      await expect(page.locator('h1').first()).toBeVisible();
      await assertA11y(page, shot('7-report'));
    });

    test(`first visit: the consent banner never covers the address box or gate fields @ ${viewport.label}`, async ({
      page,
      browserName,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockSite(page, { firstVisit: true });
      await page.goto('/');
      await expect(page.getByRole('combobox')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await page.getByRole('combobox').focus();
      await expectFocusNotObscured(page);
      await assertA11y(page, `first-visit-landing-${viewport.label}-${browserName}`, false);
      await typeAddress(page);
      await page.getByRole('option').first().click();
      await page.getByRole('radio').first().click();
      await page.locator('button.cta').focus();
      await expectFocusNotObscured(page);
      await page.locator('button.cta').click();
      await page.locator('a.cta.unlock').focus();
      await expectFocusNotObscured(page);
      await page.locator('a.cta.unlock').click();
      await expect(page.locator('h1.gate-heading')).toBeVisible();
      for (const sel of ['input[formcontrolname="name"]', 'input[formcontrolname="email"]', 'select[formcontrolname="timeline"]', 'input[formcontrolname="consent"]', 'button.cta[type="submit"]']) {
        await page.locator(sel).focus();
        await expectFocusNotObscured(page);
      }
    });

    test(`gate: focused fields are never under a sticky element @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockSite(page);
      await toPreview(page);
      await page.locator('a.cta.unlock').click();
      await expect(page.locator('h1.gate-heading')).toBeVisible();
      for (const sel of ['name', 'email', 'phone']) {
        await page.locator(`input[formcontrolname="${sel}"]`).focus();
        await expectFocusNotObscured(page);
      }
      await page.locator('select[formcontrolname="timeline"]').focus();
      await expectFocusNotObscured(page);
      await page.locator('input[formcontrolname="consent"]').focus();
      await expectFocusNotObscured(page);
      await page.locator('button.cta[type="submit"]').focus();
      await expectFocusNotObscured(page);
    });
  }

  test('keyboard only: address → scope → preview → gate → report', async ({ page, browserName }) => {
    // WebKit only moves Tab focus to links/buttons with the macOS "full
    // keyboard access" preference, so the Tab walk runs on Chromium; the
    // flow above covers WebKit rendering.
    test.skip(browserName === 'webkit', 'Tab order is covered on Chromium');
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSite(page);
    await page.goto('/');

    // Skip link / first stops, then the address combobox is reachable by Tab.
    const combobox = page.getByRole('combobox');
    for (let i = 0; i < 30 && !(await combobox.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(combobox).toBeFocused();
    await page.keyboard.type('1234 14');
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/estimate\/scope$/);
    // RouteFocusService: the new step's <main> has focus, so it is announced.
    await expect(page.locator('#main-content')).toBeFocused();

    // Project type radiogroup: reachable by Tab, chosen with Space.
    const firstRadio = page.getByRole('radio').first();
    for (let i = 0; i < 30 && !(await firstRadio.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(firstRadio).toBeFocused();
    await page.keyboard.press('Space');
    await expect(firstRadio).toHaveAttribute('aria-checked', 'true');
    const cta = page.locator('button.cta');
    for (let i = 0; i < 40 && !(await cta.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(cta).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/estimate\/preview$/);
    // RouteFocusService: the new step's <main> has focus, so it is announced.
    await expect(page.locator('#main-content')).toBeFocused();

    const unlock = page.locator('a.cta.unlock');
    for (let i = 0; i < 30 && !(await unlock.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(unlock).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/estimate\/gate$/);
    // RouteFocusService: the new step's <main> has focus, so it is announced.
    await expect(page.locator('#main-content')).toBeFocused();

    const name = page.locator('input[formcontrolname="name"]');
    for (let i = 0; i < 30 && !(await name.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(name).toBeFocused();
    await page.keyboard.type('Test Person');
    await page.keyboard.press('Tab');
    await expect(page.locator('input[formcontrolname="email"]')).toBeFocused();
    await page.keyboard.type('test@example.com');
    await page.keyboard.press('Tab');
    await expect(page.locator('input[formcontrolname="phone"]')).toBeFocused();
    await page.keyboard.type('4035551234');
    await page.keyboard.press('Tab');
    await expect(page.locator('select[formcontrolname="timeline"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    // The honeypot (tabindex=-1) is skipped: next stop is the consent box.
    await expect(page.locator('input[formcontrolname="consent"]')).toBeFocused();
    await page.keyboard.press('Space');
    const submit = page.locator('button.cta[type="submit"]');
    for (let i = 0; i < 40 && !(await submit.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(submit).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/estimate\/report$/);
  });
});
