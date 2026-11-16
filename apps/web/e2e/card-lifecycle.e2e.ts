/**
 * #879: card lifecycle UI in a real browser, 1440×900 and 390×844 — no
 * horizontal overflow, zero critical/serious axe findings.
 *
 * - Money + Billing: "Your card expires soon" / "Your card has expired"
 *   notices from the API's `expiresSoon` / `expired` flags; "Replace card"
 *   opens the card modal (simulated provider test cards), which says the new
 *   card replaces the current one.
 * - Billing: "Remove card" confirm step — a 409 shows the API's message
 *   inline; a later success shows "No card on file".
 *
 * The API is answered by the contract-shaped fixtures with the card routes
 * layered on top (Playwright runs the newest route first).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CardOnFileStatus } from '../../../packages/contracts/src/billing';
import { CARD, OVERVIEW, mockBuilderApi } from './builder-api-fixtures';

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '390', width: 390, height: 844 },
] as const;

const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');
const takeScreenshots = process.env['E2E_SCREENSHOTS'] === '1';

const CONFLICT_DETAIL =
  "This card can't be removed yet: invoice FEAS-2026-0104 is set to be charged to it. " +
  'Switch each to cheque, e-transfer or bank draft, or save a new card to replace this one.';

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function seedConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
  });
}

async function assertNoOverflowAndA11y(page: Page, shotName: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = axe.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(serious, 'axe critical/serious violations').toEqual([]);
  if (takeScreenshots) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SCREENSHOT_DIR, `${shotName}.png`), fullPage: true });
  }
}

/**
 * Card routes on top of the builder fixtures. `deletes` answers successive
 * DELETEs (409 first, then success, …); the GETs follow the current card.
 */
async function mockCard(page: Page, initial: CardOnFileStatus, deletes: Array<'conflict' | 'ok'> = []): Promise<string[]> {
  const calls: string[] = [];
  let card = initial;
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    if (path === '/api/v1/billing/card' && method === 'GET') {
      return json(route, card);
    }
    if (path === '/api/v1/billing/card' && method === 'DELETE') {
      const outcome = deletes.shift() ?? 'ok';
      calls.push(`delete ${outcome}`);
      if (outcome === 'conflict') {
        return json(
          route,
          { type: 'about:blank', title: 'Conflict', status: 409, detail: CONFLICT_DETAIL, code: 'CONFLICT', message: CONFLICT_DETAIL, retryable: false },
          409,
        );
      }
      card = { hasCard: false };
      return json(route, card);
    }
    if (path === '/api/v1/builder/billing/overview' && method === 'GET') {
      return json(route, { ...OVERVIEW, card });
    }
    if (path === '/api/v1/billing/setup-intent' && method === 'POST') {
      calls.push('setup-intent');
      return json(route, { setupIntentId: 'seti_sim_1', clientSecret: 'seti_sim_1_secret_x', provider: 'simulated' });
    }
    return route.fallback();
  });
  return calls;
}

test.describe('card lifecycle UI (#879)', () => {
  for (const viewport of VIEWPORTS) {
    test(`Money: expires-soon notice, Replace card opens the modal @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedConsent(page);
      const api = await mockBuilderApi(page, { signedIn: true });
      const calls = await mockCard(page, { ...CARD, expiresSoon: true });
      await page.goto('/builder/money');
      const notice = page.locator('[data-notice="expiring"]');
      await expect(notice).toContainText('Your card expires soon');
      await expect(page.locator('.money__card-action')).toHaveCount(0);
      await assertNoOverflowAndA11y(page, `card-expiring-money-${viewport.label}`);

      await notice.getByRole('button', { name: 'Replace card' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByTestId('simulated-card-picker')).toBeVisible();
      await expect(dialog.getByTestId('replace-note')).toContainText('Saving a new card replaces the current one.');
      await assertNoOverflowAndA11y(page, `card-replace-modal-${viewport.label}`);
      expect(calls).toEqual(['setup-intent']);
      expect(api.unhandled).toEqual([]);
    });

    test(`Billing: expired notice @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedConsent(page);
      await mockBuilderApi(page, { signedIn: true });
      await mockCard(page, { ...CARD, expired: true });
      await page.goto('/builder/billing');
      await expect(page.locator('[data-notice="expired"]')).toContainText('Your card has expired');
      await assertNoOverflowAndA11y(page, `card-expired-billing-${viewport.label}`);
    });

    test(`Billing: remove card — 409 copy, then "No card on file" @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedConsent(page);
      const api = await mockBuilderApi(page, { signedIn: true });
      const calls = await mockCard(page, CARD, ['conflict', 'ok']);
      await page.goto('/builder/billing');

      await page.getByRole('button', { name: 'Remove card' }).click();
      await expect(page.getByRole('button', { name: 'Keep card' })).toBeFocused();
      await page.getByRole('button', { name: 'Yes, remove card' }).click();
      await expect(page.getByTestId('remove-card-error')).toHaveText(CONFLICT_DETAIL);
      await assertNoOverflowAndA11y(page, `card-remove-409-${viewport.label}`);

      await page.getByRole('button', { name: 'Yes, remove card' }).click();
      await expect(page.locator('.builder-billing__empty')).toContainText('No card on file.');
      // Let the success toast finish its fade-in before axe samples contrast.
      const toast = page.locator('.ui-toast');
      await expect(toast).toContainText('Card removed.');
      await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      await assertNoOverflowAndA11y(page, `card-removed-${viewport.label}`);
      expect(calls).toEqual(['delete conflict', 'delete ok']);
      expect(api.unhandled).toEqual([]);
    });
  }
});
