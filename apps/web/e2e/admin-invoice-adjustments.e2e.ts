/**
 * #862: admin invoice adjustments (API #715), desktop and phone.
 *
 * - A card-paid invoice with refunds: the drawer lists the refund rows, the
 *   refunded total with its "Partially refunded" badge, the net paid and a
 *   "Refunded" timeline event from the audit log. Refund… opens a modal
 *   with the refunded total and net paid before → after; submitting sends
 *   one idempotency key (the same one on a retry).
 * - An in-review invoice offers Correct contract… and Void…; a manually
 *   paid one offers Reverse payment….
 * axe must report zero critical/serious issues; no horizontal scroll.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditLogListResponse, CommissionInvoice, InvoiceRefund } from '@feasly/contracts';
import { mockAdminApi } from './admin-api-fixtures';
import { INVOICES } from './builder-api-fixtures';

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '390', width: 390, height: 844 },
] as const;

const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');
const takeScreenshots = process.env['E2E_SCREENSHOTS'] === '1';

const PAID = INVOICES.find((i) => i.status === 'paid')!;
const IN_REVIEW = INVOICES.find((i) => i.status === 'in_review')!;

const REFUND: InvoiceRefund = {
  id: 'rf-1',
  invoiceId: PAID.id,
  amountCents: 20_050,
  currency: 'CAD',
  reason: 'billing_error',
  note: 'Rate applied twice on the first draft.',
  method: 'stripe',
  status: 'succeeded',
  stripeRefundId: 're_1',
  reference: null,
  actorEmail: 'ops@feasly.example',
  createdAt: '2026-11-18T17:00:00.000Z',
};

const PAID_WITH_REFUND: CommissionInvoice = {
  ...PAID,
  refundedCents: 20_050,
  refundState: 'partially_refunded',
  refunds: [REFUND],
};

const AUDIT: AuditLogListResponse = {
  items: [
    {
      id: 'billing:ev-refund-1',
      source: 'billing',
      occurredAt: REFUND.createdAt,
      actorEmail: 'ops@feasly.example',
      action: 'invoice.refunded',
      entityType: 'invoice',
      entityId: PAID.id,
      tenantKey: PAID.tenantKey,
      impersonation: false,
      payload: { amountCents: 20_050, refundedCents: 20_050, method: 'stripe', reason: 'billing_error' },
    },
  ],
  nextCursor: null,
};

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

const fulfil = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function prepare(page: Page, width: number, height: number, invoice: CommissionInvoice) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
  });
  const api = await mockAdminApi(page, { signedIn: true });
  // Registered after the fixture router, so these take precedence.
  await page.route(`**/api/v1/billing/invoices/${invoice.id}`, (route) => fulfil(route, invoice));
  await page.route('**/api/v1/admin/audit**', (route) =>
    fulfil(route, invoice.id === PAID.id ? AUDIT : { items: [], nextCursor: null }),
  );
  return api;
}

test.describe('admin invoice adjustments (#862)', () => {
  for (const viewport of VIEWPORTS) {
    test(`refund rows, timeline and the refund modal @ ${viewport.label}`, async ({ page }) => {
      const api = await prepare(page, viewport.width, viewport.height, PAID_WITH_REFUND);
      const bodies: Array<{ idempotencyKey: string; amountCents: number }> = [];
      let attempts = 0;
      await page.route(`**/api/v1/admin/billing/invoices/${PAID.id}/refund`, (route) => {
        bodies.push(route.request().postDataJSON());
        attempts += 1;
        // The first attempt fails like a Stripe outage; the retry succeeds.
        return attempts === 1
          ? fulfil(route, { error: { code: 'PROVIDER_ERROR', message: 'Stripe unavailable' } }, 502)
          : fulfil(route, {
              invoiceId: PAID.id,
              status: 'paid',
              totalCents: PAID.totalCents,
              refundedCents: 30_050,
              netCents: PAID.totalCents - 30_050,
              refundState: 'partially_refunded',
              currency: 'CAD',
              refund: { ...REFUND, id: 'rf-2', amountCents: 10_000 },
              replayed: false,
            });
      });

      await page.goto(`/admin/billing/invoices?open=${PAID.id}`);
      const drawer = page.getByRole('dialog');
      await expect(drawer.getByTestId('invoice-refunded')).toContainText('$200.50');
      await expect(drawer.getByTestId('invoice-refunded')).toContainText('Partially refunded');
      await expect(drawer.getByTestId('invoice-net-paid')).toContainText('$7,249.50');
      await expect(drawer.getByTestId('invoice-refund-row')).toContainText('Billing error');
      await expect(drawer).toContainText('Refunded');
      await expect(drawer.getByTestId('action-refund')).toBeVisible();
      await expect(drawer.getByTestId('action-void')).toHaveCount(0);
      await expect(drawer.getByTestId('action-reverse')).toHaveCount(0);
      await assertA11y(page);
      await shot(page, `invoice-refunds-drawer-${viewport.label}`);

      await drawer.getByTestId('action-refund').click();
      const modal = page.getByRole('dialog', { name: 'Refund invoice' });
      await expect(modal).toBeVisible();
      await modal.getByLabel('Amount to refund ($)').fill('100');
      await modal.getByLabel('Reason').selectOption('goodwill');
      await expect(modal.getByTestId('refund-refunded-after')).toHaveText('$300.50');
      await expect(modal.getByTestId('refund-net-after')).toHaveText('$7,149.50');
      await assertA11y(page);
      await shot(page, `invoice-refund-modal-${viewport.label}`);

      await modal.getByTestId('refund-submit').click();
      await expect(modal.getByRole('alert')).toContainText('never refunded twice');
      await modal.getByTestId('refund-submit').click();
      await expect(modal).toHaveCount(0);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toMatchObject({ amountCents: 10_000, reason: 'goodwill' });
      expect(bodies[1].idempotencyKey).toBe(bodies[0].idempotencyKey);

      expect(api.unhandled).toEqual([]);
    });

    test(`void and correct-contract modals @ ${viewport.label}`, async ({ page }) => {
      const api = await prepare(page, viewport.width, viewport.height, IN_REVIEW);
      await page.goto(`/admin/billing/invoices?open=${IN_REVIEW.id}`);
      const drawer = page.getByRole('dialog');
      await expect(drawer.getByTestId('action-correct')).toBeVisible();
      await expect(drawer.getByTestId('action-void')).toBeVisible();
      await expect(drawer.getByTestId('action-refund')).toHaveCount(0);

      await drawer.getByTestId('action-void').click();
      const voidModal = page.getByRole('dialog', { name: 'Void invoice' });
      await expect(voidModal.getByTestId('void-before-after')).toContainText('$13,487.25');
      await assertA11y(page);
      await shot(page, `invoice-void-modal-${viewport.label}`);
      await voidModal.getByRole('button', { name: 'Cancel' }).click();
      await expect(voidModal).toHaveCount(0);

      await drawer.getByTestId('action-correct').click();
      const contractModal = page.getByRole('dialog', { name: 'Correct contract' });
      await contractModal.getByLabel('Signed contract value (excl. land)').fill('1200000');
      await expect(contractModal.getByTestId('contract-commission-after')).toHaveText('$12,000');
      await assertA11y(page);
      await shot(page, `invoice-contract-modal-${viewport.label}`);

      expect(api.unhandled).toEqual([]);
    });

    test(`reverse a manual payment @ ${viewport.label}`, async ({ page }) => {
      const manual: CommissionInvoice = {
        ...PAID,
        stripePaymentIntentId: null,
        manualPaymentMethod: 'cheque',
        paymentReference: 'CHQ-1042',
        refundedCents: 0,
        refundState: 'none',
      };
      const api = await prepare(page, viewport.width, viewport.height, manual);
      await page.goto(`/admin/billing/invoices?open=${PAID.id}`);
      const drawer = page.getByRole('dialog');
      await drawer.getByTestId('action-reverse').click();
      const modal = page.getByRole('dialog', { name: 'Reverse payment' });
      await expect(modal.getByTestId('reverse-context')).toContainText('CHQ-1042');
      await expect(modal.getByTestId('reverse-submit')).toBeDisabled();
      await modal.getByLabel('Reason').fill('Cheque bounced');
      await expect(modal.getByTestId('reverse-submit')).toBeEnabled();
      await assertA11y(page);
      await shot(page, `invoice-reverse-modal-${viewport.label}`);

      expect(api.unhandled).toEqual([]);
    });
  }
});
