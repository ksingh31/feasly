/**
 * #872: Stripe chargebacks in the admin console, desktop and phone.
 *
 * The disputes queue marks the chargeback row (and only it) with a
 * "Chargeback" chip and an evidence-deadline countdown. Its drawer shows
 * the disputed amount and Stripe reason, hides Accept / Reject (the API
 * answers 409) and links "View in Stripe" to the test-mode dashboard
 * (`livemode: false`). The link disappears for the simulated provider.
 * axe must report zero critical/serious issues; no horizontal scroll.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BILLING_HEALTH, mockAdminApi } from './admin-api-fixtures';

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '390', width: 390, height: 844 },
] as const;

const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');
const takeScreenshots = process.env['E2E_SCREENSHOTS'] === '1';

const STRIPE_URL = 'https://dashboard.stripe.com/test/disputes/dp_1QxE2eChargebackFixture000001';

async function assertA11y(page: Page): Promise<void> {
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = axe.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(serious, 'axe critical/serious violations').toEqual([]);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!takeScreenshots) return;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' });
}

async function prepare(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
  });
  return mockAdminApi(page, { signedIn: true });
}

test.describe('admin chargebacks (#872)', () => {
  for (const viewport of VIEWPORTS) {
    test(`queue chip and drawer @ ${viewport.label}`, async ({ page }) => {
      const api = await prepare(page, viewport.width, viewport.height);

      await page.goto('/admin/disputes');
      const chips = page.locator('[data-testid="chargeback-chip"]:visible');
      await expect(chips).toHaveCount(1);
      await expect(chips.first()).toHaveText('Chargeback');
      await expect(page.locator('[data-testid="sla-chip"]:visible', { hasText: 'Evidence due in 6 days' })).toHaveCount(1);
      await assertA11y(page);
      await shot(page, `chargeback-queue-${viewport.label}`);

      await page.goto('/admin/disputes?open=chargeback-1');
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByTestId('drawer-chargeback-chip')).toHaveText('Chargeback');
      await expect(dialog).toContainText('Disputed amount');
      await expect(dialog).toContainText('Product not received');
      await expect(dialog.getByTestId('drawer-accept')).toHaveCount(0);
      await expect(dialog.getByTestId('drawer-reject')).toHaveCount(0);
      const link = dialog.getByTestId('drawer-view-in-stripe');
      await expect(link).toHaveAttribute('href', STRIPE_URL);
      await expect(link).toHaveAttribute('target', '_blank');
      await assertA11y(page);
      await shot(page, `chargeback-drawer-${viewport.label}`);

      expect(api.unhandled).toEqual([]);
    });
  }

  test('hides "View in Stripe" for the simulated provider', async ({ page }) => {
    await prepare(page, 1440, 900);
    // Registered after the fixture router, so it takes precedence.
    await page.route('**/api/v1/admin/billing', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...BILLING_HEALTH, stripe: { ...BILLING_HEALTH.stripe, provider: 'simulated' } }),
      }),
    );
    await page.goto('/admin/disputes?open=chargeback-1');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('drawer-chargeback-footer')).toBeVisible();
    await expect(dialog.getByTestId('drawer-view-in-stripe')).toHaveCount(0);
  });
});
