/**
 * #901: dunning on the web, desktop and phone.
 *
 * Builder: a failed card invoice shows its next automatic retry and a Pay
 * now button that is disabled while the charge is in flight and sends one
 * request; a manual-method invoice past its due date reads as overdue.
 *
 * Admin: the dunning queue shows the schedule (state, next retry, grace
 * days) with collections rows on top and their age, Pause / Resume /
 * Cancel / Edit grace days controls, and in-review manual invoices read
 * "Awaiting manual payment — N days".
 *
 * axe must report zero critical/serious issues; no horizontal scroll.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BillingHealthResponse, CommissionInvoice } from '@feasly/contracts';
import { BILLING_HEALTH, mockAdminApi } from './admin-api-fixtures';
import { INVOICES, mockBuilderApi } from './builder-api-fixtures';

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '390', width: 390, height: 844 },
] as const;

const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');
const takeScreenshots = process.env['E2E_SCREENSHOTS'] === '1';
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const daysAhead = (d: number) => new Date(Date.now() + d * DAY).toISOString();

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

async function seedConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
  });
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// ---- Builder fixtures ------------------------------------------------------

const FAILED = INVOICES.find((i) => i.status === 'failed')!;
const FAILED_SCHEDULED: CommissionInvoice = {
  ...FAILED,
  retryGraceDays: 7,
  maxChargeRetries: 3,
  nextRetryAt: daysAhead(5),
  dunningState: 'active',
  collectionsAt: null,
  dueAt: null,
  overdueDays: 0,
};
const MANUAL_OVERDUE: CommissionInvoice = {
  ...INVOICES[0]!,
  id: '00000000-0000-4000-8000-000000000009',
  invoiceNumber: 'INV-0049',
  leadName: 'Sam Wu',
  status: 'in_review',
  paymentMethod: 'cheque',
  reviewDueAt: daysAgo(10),
  dueAt: daysAgo(3),
  overdueDays: 3,
};
const BUILDER_INVOICES = [...INVOICES.map((i) => (i.id === FAILED.id ? FAILED_SCHEDULED : i)), MANUAL_OVERDUE];

async function prepareBuilder(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await seedConsent(page);
  const api = await mockBuilderApi(page, { signedIn: true });
  const payCalls: string[] = [];
  let releasePay: () => void = () => undefined;
  const payGate = new Promise<void>((resolve) => (releasePay = resolve));
  // Registered after the fixture router, so these take precedence.
  await page.route('**/api/v1/billing/invoices**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'GET' && path === '/api/v1/billing/invoices') {
      const statuses = new URL(req.url()).searchParams.get('status')?.split(',').filter(Boolean);
      return json(route, statuses ? BUILDER_INVOICES.filter((i) => statuses.includes(i.status)) : BUILDER_INVOICES);
    }
    const one = /^\/api\/v1\/billing\/invoices\/([^/]+)$/.exec(path);
    if (req.method() === 'GET' && one) {
      const found = BUILDER_INVOICES.find((i) => i.id === one[1]);
      return found ? json(route, found) : route.fallback();
    }
    const pay = /^\/api\/v1\/billing\/invoices\/([^/]+)\/pay$/.exec(path);
    if (req.method() === 'POST' && pay) {
      payCalls.push(pay[1]!);
      await payGate;
      return json(route, { ...FAILED_SCHEDULED, status: 'paid', paidAt: new Date().toISOString(), nextRetryAt: null });
    }
    return route.fallback();
  });
  return { api, payCalls, releasePay };
}

// ---- Admin fixtures --------------------------------------------------------

const DUNNING_ROW = BILLING_HEALTH.dunning[0]!;
const ADMIN_HEALTH: BillingHealthResponse = {
  ...BILLING_HEALTH,
  dunning: [
    { ...DUNNING_ROW, nextRetryAt: daysAhead(5), dunningState: 'active', retryGraceDays: 7, collectionsAt: null },
    {
      ...DUNNING_ROW,
      id: 'dunning-collections-1',
      commissionCents: 432_100,
      retryCount: 3,
      nextRetryAt: null,
      dunningState: 'active',
      retryGraceDays: 7,
      collectionsAt: daysAgo(4),
    },
  ],
  inReviewInvoices: [
    ...BILLING_HEALTH.inReviewInvoices,
    {
      ...BILLING_HEALTH.inReviewInvoices[0]!,
      id: 'manual-overdue-1',
      paymentMethod: 'cheque',
      reviewDueAt: daysAgo(10),
      dueAt: daysAgo(3),
      overdueDays: 3,
    },
  ],
};

async function prepareAdmin(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await seedConsent(page);
  const api = await mockAdminApi(page, { signedIn: true });
  const dunningBodies: unknown[] = [];
  await page.route('**/api/v1/admin/billing**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'GET' && path === '/api/v1/admin/billing') return json(route, ADMIN_HEALTH);
    if (req.method() === 'POST' && /\/invoices\/[^/]+\/dunning$/.test(path)) {
      const body = req.postDataJSON() as { action: string; graceDays?: number };
      dunningBodies.push(body);
      return json(route, {
        invoiceId: DUNNING_ROW.id,
        status: 'failed',
        dunningState: body.action === 'pause' ? 'paused' : body.action === 'cancel' ? 'cancelled' : 'active',
        retryGraceDays: body.graceDays ?? 7,
        nextRetryAt: null,
      });
    }
    return route.fallback();
  });
  return { api, dunningBodies };
}

test.describe('billing dunning (#901)', () => {
  for (const viewport of VIEWPORTS) {
    test(`builder: next retry, Pay now and overdue @ ${viewport.label}`, async ({ page }) => {
      const { api, payCalls, releasePay } = await prepareBuilder(page, viewport.width, viewport.height);

      await page.goto('/builder/invoices');
      await expect(page.locator('[data-testid="invoice-due-note"]:visible', { hasText: 'Overdue 3 days' })).toHaveCount(1);
      await expect(page.locator('[data-testid="invoice-due-note"]:visible', { hasText: 'Retries' })).toHaveCount(1);
      await assertA11y(page);
      await shot(page, `dunning-builder-list-${viewport.label}`);

      await page.goto(`/builder/invoices?open=${FAILED.id}`);
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByTestId('invoice-next-retry')).not.toHaveText('None scheduled');
      const payNow = dialog.getByTestId('invoice-pay-now-cta');
      await expect(payNow).toHaveText('Pay now');
      await assertA11y(page);
      await shot(page, `dunning-builder-drawer-${viewport.label}`);

      await payNow.click();
      await expect(payNow).toBeDisabled();
      await expect(payNow).toHaveText('Paying…');
      await payNow.click({ force: true });
      releasePay();
      await expect(dialog.getByTestId('invoice-pay-now')).toHaveCount(0);
      await expect(dialog).toContainText('Payment received');
      expect(payCalls).toEqual([FAILED.id]);

      await page.goto(`/builder/invoices?open=${MANUAL_OVERDUE.id}`);
      await expect(page.getByRole('dialog').getByTestId('invoice-overdue')).toContainText('3 days overdue');
      await assertA11y(page);
      await shot(page, `dunning-builder-overdue-${viewport.label}`);

      expect(api.unhandled).toEqual([]);
    });

    test(`admin: schedule, collections and controls @ ${viewport.label}`, async ({ page }) => {
      const { api, dunningBodies } = await prepareAdmin(page, viewport.width, viewport.height);

      await page.goto('/admin/billing');
      const queue = page.getByTestId('dunning-queue');
      await expect(queue).toContainText('Collections · 4 days');
      await expect(queue).toContainText('Active');
      await expect(page.getByTestId('in-review-queue')).toContainText('Awaiting manual payment — 3 days');
      // Collections sit at the top of the queue.
      const firstRow = queue.locator('tbody tr, li').filter({ hasText: '$' }).first();
      await expect(firstRow).toContainText('$4,321');
      await assertA11y(page);
      await shot(page, `dunning-admin-queue-${viewport.label}`);

      // Pause from the second (active, scheduled) row's overflow menu.
      await queue.locator('.row-actions__trigger:visible').nth(1).click();
      await page.locator('.row-actions__item[data-action="dunning-pause"]').click();
      await expect(page.getByText('Automatic retries paused.')).toBeVisible();
      expect(dunningBodies).toEqual([{ action: 'pause' }]);

      // Edit grace days in the focused modal.
      await queue.locator('.row-actions__trigger:visible').nth(1).click();
      await page.locator('.row-actions__item[data-action="dunning-grace"]').click();
      const modal = page.getByRole('dialog');
      await expect(modal).toContainText('Edit grace days');
      await assertA11y(page);
      await shot(page, `dunning-admin-grace-${viewport.label}`);
      const input = modal.locator('input');
      await input.fill('14');
      await modal.getByTestId('grace-days-submit').click();
      await expect(page.getByText('Grace period set to 14 days.')).toBeVisible();
      expect(dunningBodies).toContainEqual({ action: 'set_grace_days', graceDays: 14 });

      expect(api.unhandled).toEqual([]);
    });
  }
});
