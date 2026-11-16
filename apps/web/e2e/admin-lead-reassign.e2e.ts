/**
 * #803: admin lead reassignment in a real browser, desktop and phone.
 *
 * Opens the lead drawer (lead-1 is assigned to Elite Craft), checks the
 * "Builder changes" history, moves the lead to another builder, and checks
 * the confirm dialog states the consequences. Confirming hits a 409
 * LEAD_HAS_INVOICE, and its message must show inline in the drawer. axe
 * must report zero critical/serious issues on the drawer and the dialog.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mockAdminApi } from './admin-api-fixtures';

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '390', width: 390, height: 844 },
] as const;

const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');
const takeScreenshots = process.env['E2E_SCREENSHOTS'] === '1';

const BLOCKED = 'Invoice INV-0042 exists for this lead. Void or refund it before moving the lead.';

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

test.describe('admin lead reassignment (#803)', () => {
  for (const viewport of VIEWPORTS) {
    test(`confirm dialog, history and blocked move @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript(() => {
        window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
      });
      const api = await mockAdminApi(page, { signedIn: true });
      // Registered after the fixture router, so it takes precedence.
      await page.route('**/api/v1/admin/leads/*/assign-builder', (route) =>
        route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'LEAD_HAS_INVOICE', message: BLOCKED }),
        }),
      );

      await page.goto('/admin/leads?open=lead-1');
      const drawer = page.locator('[role="dialog"]:visible').first();
      await expect(drawer).toBeVisible();

      // History: newest first, builder names resolved.
      const history = drawer.getByTestId('lead-reassignments');
      await expect(history.locator('li')).toHaveCount(2);
      await expect(history.locator('li').first()).toContainText('Northern Lights Custom Homes & Renovations Ltd. → Elite Craft Builders');
      await expect(history.locator('li').nth(1)).toContainText('Unassigned → Northern Lights');
      await history.scrollIntoViewIfNeeded();
      await assertA11y(page);
      await shot(page, `admin-lead-reassign-history-${viewport.label}`);

      // Move to another builder → confirm dialog states the consequences.
      await drawer.getByLabel('Assigned builder').selectOption('b-2');
      await drawer.getByRole('button', { name: 'Save', exact: true }).click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText('Elite Craft Builders will lose access to this lead.');
      await expect(confirm).toContainText('Reassigned by Feasly');
      await assertA11y(page);
      await shot(page, `admin-lead-reassign-confirm-${viewport.label}`);

      // Confirm → 409 message inline in the drawer.
      await confirm.getByRole('button', { name: 'Move lead', exact: true }).click();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(drawer.locator('.lead-drawer__error[role="alert"]')).toHaveText(BLOCKED);
      await assertA11y(page);
      await shot(page, `admin-lead-reassign-blocked-${viewport.label}`);

      expect(api.unhandled, 'API calls with no fixture').toEqual([]);
    });
  }
});
