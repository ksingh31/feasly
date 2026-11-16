/**
 * #791: simulated payment provider UI in a real browser, 1440×900 and
 * 390×844 — no horizontal overflow, zero critical/serious axe findings.
 *
 * - Builder card modal: the test-card picker + "Test mode — no real
 *   charges" banner when POST /billing/setup-intent answers
 *   `provider: 'simulated'`; the 3DS card adds the "Complete 3DS
 *   challenge" step; Complete saves the card.
 * - Builder card modal with `provider: 'stripe'` and no publishable key:
 *   the calm contact copy, never the picker (AC2).
 * - Builder invoice drawer: an `action_required` invoice offers the 3DS
 *   step for its simulated PaymentIntent.
 * - Admin invoice drawer: the dev panel only when GET /admin/billing
 *   reports `stripe.provider === 'simulated'`; firing shows the eventType.
 *
 * The API is answered by the contract-shaped fixtures, with the simulated
 * endpoints layered on top (Playwright runs the newest route first).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SIMULATED_PAYMENTS_NOTICE } from '../../../packages/contracts/src/payments';
import { BILLING_HEALTH, mockAdminApi } from './admin-api-fixtures';
import { INVOICES, mockBuilderApi } from './builder-api-fixtures';

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '390', width: 390, height: 844 },
] as const;

const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');
const takeScreenshots = process.env['E2E_SCREENSHOTS'] === '1';

const PAID = INVOICES.find((i) => i.status === 'paid')!;
const WAITING = { ...INVOICES.find((i) => i.status === 'failed')!, status: 'action_required' as const, stripePaymentIntentId: 'pi_sim_1' };

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
    await page.screenshot({ path: join(SCREENSHOT_DIR, `${shotName}.png`) });
  }
}

/** Simulated builder billing endpoints on top of the builder fixtures. */
async function mockSimulatedBuilder(page: Page, provider: 'stripe' | 'simulated'): Promise<string[]> {
  const calls: string[] = [];
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    if (method === 'POST' && path === '/api/v1/billing/setup-intent') {
      calls.push('setup-intent');
      return json(route, { setupIntentId: 'seti_sim_1', clientSecret: 'seti_sim_1_secret_x', provider });
    }
    if (method === 'POST' && path === '/api/v1/billing/simulated/confirm-setup') {
      const body = req.postDataJSON() as { cardNumber: string };
      calls.push(`confirm-setup ${body.cardNumber}`);
      return body.cardNumber === '4000002760003184'
        ? json(route, { intentId: 'seti_sim_1', status: 'requires_action', nextAction: 'three_d_secure' })
        : json(route, { intentId: 'seti_sim_1', status: 'succeeded' });
    }
    if (method === 'POST' && path === '/api/v1/billing/simulated/authenticate') {
      const body = req.postDataJSON() as { intentId: string; outcome: string };
      calls.push(`authenticate ${body.intentId} ${body.outcome}`);
      return json(route, { intentId: body.intentId, status: body.outcome === 'complete' ? 'succeeded' : 'requires_payment_method' });
    }
    if (method === 'POST' && path === `/api/v1/billing/invoices/${WAITING.id}/confirm-payment`) {
      calls.push('confirm-payment');
      return json(route, { invoiceId: WAITING.id, paymentIntentId: 'pi_sim_1', clientSecret: 'pi_sim_1_secret_x', provider });
    }
    if (method === 'GET' && path === `/api/v1/billing/invoices/${WAITING.id}`) {
      return json(route, WAITING);
    }
    return route.fallback();
  });
  return calls;
}

test.describe('simulated payment provider UI (#791)', () => {
  for (const viewport of VIEWPORTS) {
    test(`builder card modal: picker + 3DS step @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedConsent(page);
      const api = await mockBuilderApi(page, { signedIn: true });
      const calls = await mockSimulatedBuilder(page, 'simulated');
      await page.goto('/builder/money');
      await page.locator('.money__card-action').click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByTestId('simulated-card-picker')).toBeVisible();
      await expect(dialog.getByTestId('simulated-notice')).toHaveText(SIMULATED_PAYMENTS_NOTICE);
      await assertNoOverflowAndA11y(page, `sim-card-picker-${viewport.label}`);

      await dialog.getByLabel('Visa — 3D Secure required').check();
      await dialog.getByRole('button', { name: 'Save card' }).click();
      await expect(dialog.getByTestId('simulated-challenge')).toBeVisible();
      await assertNoOverflowAndA11y(page, `sim-card-3ds-${viewport.label}`);

      await dialog.getByTestId('simulated-challenge-complete').click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(calls).toEqual(['setup-intent', 'confirm-setup 4000002760003184', 'authenticate seti_sim_1 complete']);
      expect(api.unhandled).toEqual([]);
    });

    test(`builder card modal: no picker for the Stripe provider @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedConsent(page);
      await mockBuilderApi(page, { signedIn: true });
      await mockSimulatedBuilder(page, 'stripe');
      await page.goto('/builder/money');
      await page.locator('.money__card-action').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('note')).toBeVisible();
      await expect(dialog.getByTestId('simulated-card-picker')).toHaveCount(0);
      await expect(dialog).not.toContainText(SIMULATED_PAYMENTS_NOTICE);
    });

    test(`builder invoice drawer: 3DS step for an action_required charge @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedConsent(page);
      await mockBuilderApi(page, { signedIn: true });
      const calls = await mockSimulatedBuilder(page, 'simulated');
      await page.goto(`/builder/invoices?open=${WAITING.id}`);
      await expect(page.getByTestId('invoice-confirm-payment')).toBeVisible();
      await assertNoOverflowAndA11y(page, `sim-invoice-3ds-${viewport.label}`);
      await page.getByTestId('simulated-challenge-fail').click();
      await expect(page.getByTestId('invoice-confirm-payment')).toHaveCount(0);
      expect(calls).toContain('authenticate pi_sim_1 fail');
    });

    test(`admin invoice drawer: dev panel for the simulated provider @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedConsent(page);
      const api = await mockAdminApi(page, { signedIn: true });
      const fired: unknown[] = [];
      await page.route('**/api/**', (route) => {
        const req = route.request();
        const path = new URL(req.url()).pathname;
        if (req.method() === 'GET' && path === '/api/v1/admin/billing') {
          return json(route, { ...BILLING_HEALTH, stripe: { ...BILLING_HEALTH.stripe, provider: 'simulated' } });
        }
        if (req.method() === 'POST' && path === `/api/v1/admin/billing/simulated/invoices/${PAID.id}/events`) {
          fired.push(req.postDataJSON());
          return json(route, { invoiceId: PAID.id, paymentIntentId: 'pi_sim_1', kind: 'refund', eventType: 'charge.refunded' });
        }
        return route.fallback();
      });
      await page.goto(`/admin/billing/invoices?open=${PAID.id}`);
      const panel = page.getByTestId('simulated-dev-panel');
      await expect(panel).toBeVisible();
      await panel.scrollIntoViewIfNeeded();
      await assertNoOverflowAndA11y(page, `sim-admin-panel-${viewport.label}`);
      await panel.getByLabel('Refund amount (cents)').fill('2500');
      await panel.getByTestId('sim-refund').click();
      await expect(panel.getByTestId('sim-result')).toContainText('charge.refunded');
      expect(fired).toEqual([{ kind: 'refund', amountCents: 2500 }]);
      expect(api.unhandled).toEqual([]);
    });

    test(`admin invoice drawer: no dev panel for the Stripe provider @ ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedConsent(page);
      await mockAdminApi(page, { signedIn: true });
      await page.goto(`/admin/billing/invoices?open=${PAID.id}`);
      await expect(page.getByText('Technical IDs')).toBeVisible();
      await expect(page.getByTestId('simulated-dev-panel')).toHaveCount(0);
    });
  }
});
