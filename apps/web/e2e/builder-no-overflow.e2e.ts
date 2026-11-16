/**
 * #536: no horizontal overflow on any builder portal route, desktop and
 * phone (artboard "Builder · Inbox on phone").
 *
 * For every route in BUILDER_E2E_ROUTES at 1440×900 and 390×844:
 *   - the page settles (ready selector visible, no skeletons),
 *   - `document.documentElement.scrollWidth <= window.innerWidth`,
 *   - axe reports zero critical/serious violations,
 *   - every API call was answered by a fixture (no silent 404s).
 * The leads page is also checked with the lead drawer open (?open=), the
 * densest phone layout.
 *
 * jsdom can't measure layout, so this is the real-browser counterpart of
 * the static guard in tools/mobile-tables.spec.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { INVOICES, mockBuilderApi } from './builder-api-fixtures';
import { BUILDER_E2E_ROUTES } from './builder-routes';
import type { BuilderE2eRoute } from './builder-routes';

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '390', width: 390, height: 844 },
] as const;

const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');
const takeScreenshots = process.env['E2E_SCREENSHOTS'] === '1';

interface Overflow {
  readonly scrollWidth: number;
  readonly innerWidth: number;
  /** Elements whose right edge passes the viewport (debug aid on failure). */
  readonly offenders: readonly string[];
}

function measureOverflow(page: Page): Promise<Overflow> {
  return page.evaluate(() => {
    const innerWidth = window.innerWidth;
    const offenders: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > innerWidth + 1 && offenders.length < 10) {
        const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '';
        offenders.push(`${el.tagName.toLowerCase()}${cls} (right=${Math.round(rect.right)})`);
      }
    }
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth, offenders };
  });
}

/**
 * A returning builder has already answered the analytics prompt; seed that
 * choice (NGXS storage-plugin key `consent`) so the fixed consent banner
 * doesn't cover the page in the screenshots.
 */
async function seedConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
  });
}

async function settle(page: Page, ready: string): Promise<void> {
  await expect(page.locator(ready).first()).toBeVisible();
  await expect(page.locator('ui-skeleton')).toHaveCount(0);
  // Let fonts and late layout (sticky footers, drawers) finish.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function assertNoOverflowAndA11y(page: Page, shotName: string, fullPage = true): Promise<void> {
  const overflow = await measureOverflow(page);
  expect(
    overflow.scrollWidth,
    `scrollWidth ${overflow.scrollWidth} > innerWidth ${overflow.innerWidth}; offenders: ${overflow.offenders.join(', ')}`,
  ).toBeLessThanOrEqual(overflow.innerWidth);

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = axe.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(serious, 'axe critical/serious violations').toEqual([]);

  if (takeScreenshots) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SCREENSHOT_DIR, `${shotName}.png`), fullPage });
  }
}

function visit(route: BuilderE2eRoute, viewport: (typeof VIEWPORTS)[number]): void {
  test(`${route.url} @ ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await seedConsent(page);
    const api = await mockBuilderApi(page, { signedIn: !route.public });
    await page.goto(route.url);
    await settle(page, route.ready);
    await assertNoOverflowAndA11y(page, `builder-${route.name}-${viewport.label}`);
    expect(api.unhandled, 'API calls with no fixture').toEqual([]);
  });
}

test.describe('builder portal: no horizontal overflow (#536)', () => {
  for (const viewport of VIEWPORTS) {
    for (const route of BUILDER_E2E_ROUTES) {
      visit(route, viewport);
    }

    test(`/builder lead drawer open @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedConsent(page);
      const api = await mockBuilderApi(page, { signedIn: true });
      await page.goto('/builder?open=lead-2');
      await settle(page, '[role="dialog"]');
      // Viewport capture: the drawer is fixed, a full-page shot misleads.
      await assertNoOverflowAndA11y(page, `builder-lead-drawer-${viewport.label}`, false);
      expect(api.unhandled, 'API calls with no fixture').toEqual([]);
    });

    // #764: a GST-taxed invoice — subtotal, "GST (5%)" and total rows.
    test(`/builder/invoices taxed invoice drawer open @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedConsent(page);
      const api = await mockBuilderApi(page, { signedIn: true });
      await page.goto(`/builder/invoices?open=${INVOICES[0]!.id}`);
      await settle(page, '[data-testid="invoice-total"]');
      await expect(page.locator('[data-testid="invoice-tax"]')).toContainText('GST (5%)');
      await assertNoOverflowAndA11y(page, `builder-invoice-drawer-gst-${viewport.label}`, false);
      expect(api.unhandled, 'API calls with no fixture').toEqual([]);
    });
  }
});
