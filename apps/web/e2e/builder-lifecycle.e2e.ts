/**
 * #861: builder lifecycle UI, desktop (1440) and phone (390×844).
 *
 * Admin: the builder drawer's "Account status" section — Suspend opens a
 * confirm with a mandatory reason, posts it, and the status updates in
 * place; an offboarding builder shows the checklist with its blocker
 * linked to the invoice, and "Complete offboarding" refused for blockers
 * keeps the confirm open with the server's reason.
 *
 * Builder: a 403 BUILDER_PAUSED swaps the page for "Your account is
 * paused" instead of a generic error.
 *
 * axe must report zero critical/serious issues; no horizontal scroll.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Builder, BuilderLifecycleBody } from '@feasly/contracts';
import { ADMIN_BUILDERS, mockAdminApi } from './admin-api-fixtures';
import { INVOICES, mockBuilderApi } from './builder-api-fixtures';

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '390', width: 390, height: 844 },
] as const;

const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');
const takeScreenshots = process.env['E2E_SCREENSHOTS'] === '1';

const PAUSED_MESSAGE = 'This builder account is paused. Contact Feasly to restore access.';
const UNPAID = INVOICES[0]!;

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

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function prepare(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  // Drawer/sheet slide-ins are instant, so axe samples settled colours.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
  });
}

/** b-2 is mid-offboarding with a recorded reason. */
const BUILDERS: Builder[] = ADMIN_BUILDERS.builders.map((b) =>
  b.id === 'b-2'
    ? {
        ...b,
        status: 'offboarding',
        statusReason: 'Builder is retiring at year end.',
        statusChangedAt: '2026-11-10T17:00:00.000Z',
        statusChangedBy: 'ops@feasly.example',
      }
    : b,
);

/** Lifecycle routes on top of the shared admin fixtures (registered later = matched first). */
async function mockLifecycle(page: Page): Promise<BuilderLifecycleBody[]> {
  const posted: BuilderLifecycleBody[] = [];
  await page.route('**/api/v1/admin/builders**', (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'GET' && path === '/api/v1/admin/builders') {
      return json(route, { builders: BUILDERS });
    }
    if (req.method() === 'GET' && path === '/api/v1/admin/builders/b-2/offboarding-blockers') {
      return json(route, {
        blockers: [
          { kind: 'unpaid_invoice', invoiceId: UNPAID.id, invoiceNumber: UNPAID.invoiceNumber, status: UNPAID.status },
        ],
      });
    }
    const status = /^\/api\/v1\/admin\/builders\/([^/]+)\/status$/.exec(path);
    if (req.method() === 'POST' && status) {
      const body = req.postDataJSON() as BuilderLifecycleBody;
      posted.push(body);
      if (body.action === 'complete_offboarding') {
        return json(
          route,
          {
            code: 'OFFBOARDING_BLOCKED',
            message: `Offboarding can't be completed yet: ${UNPAID.invoiceNumber} is unpaid.`,
          },
          409,
        );
      }
      const row = BUILDERS.find((b) => b.id === status[1])!;
      return json(route, {
        builder: {
          ...row,
          status: body.action === 'suspend' ? 'suspended' : 'active',
          statusReason: body.reason,
          statusChangedAt: '2026-11-16T15:00:00.000Z',
          statusChangedBy: 'ops@feasly.example',
        },
        changed: true,
      });
    }
    return route.fallback();
  });
  return posted;
}

test.describe('builder lifecycle — admin (#861)', () => {
  for (const viewport of VIEWPORTS) {
    test(`suspend confirm with mandatory reason @ ${viewport.label}`, async ({ page }) => {
      await prepare(page, viewport.width, viewport.height);
      const api = await mockAdminApi(page, { signedIn: true });
      const posted = await mockLifecycle(page);

      await page.goto('/admin/builders?open=b-1');
      const drawer = page.getByRole('dialog');
      const section = drawer.getByTestId('account-status');
      await expect(section).toContainText('Account status');
      await expect(section.getByTestId('lifecycle-suspend')).toBeVisible();
      await assertA11y(page);
      await shot(page, `lifecycle-drawer-${viewport.label}`);

      await section.getByTestId('lifecycle-suspend').click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toContainText('Suspend Elite Craft Builders?');
      await confirm.getByTestId('lifecycle-submit').click();
      await expect(confirm).toContainText('Enter a reason of at least 3 characters.');
      expect(posted).toEqual([]);
      await assertA11y(page);
      await shot(page, `lifecycle-suspend-confirm-${viewport.label}`);

      await confirm.getByTestId('lifecycle-reason').fill('Three invoices past due');
      await confirm.getByTestId('lifecycle-submit').click();
      await expect(confirm).toHaveCount(0);
      expect(posted).toEqual([{ action: 'suspend', reason: 'Three invoices past due' }]);
      await expect(section.getByTestId('status-reason')).toContainText('Three invoices past due');
      await expect(section.getByTestId('lifecycle-reactivate')).toBeVisible();

      expect(api.unhandled).toEqual([]);
    });

    test(`offboarding checklist and blocked completion @ ${viewport.label}`, async ({ page }) => {
      await prepare(page, viewport.width, viewport.height);
      const api = await mockAdminApi(page, { signedIn: true });
      await mockLifecycle(page);

      await page.goto('/admin/builders?open=b-2');
      const drawer = page.getByRole('dialog');
      const checklist = drawer.getByTestId('offboarding-checklist');
      const blocker = checklist.getByTestId('checklist-blocker');
      await expect(blocker).toHaveCount(1);
      await expect(blocker).toHaveAttribute('href', `/admin/billing/invoices?open=${UNPAID.id}`);
      await expect(drawer.getByTestId('status-reason')).toContainText('Builder is retiring at year end.');
      await assertA11y(page);
      await shot(page, `lifecycle-checklist-${viewport.label}`);

      await drawer.getByTestId('lifecycle-complete_offboarding').click();
      const confirm = page.getByRole('alertdialog');
      await confirm.getByTestId('lifecycle-reason').fill('Relationship ended');
      await confirm.getByTestId('lifecycle-submit').click();
      await expect(confirm.getByTestId('lifecycle-error')).toContainText("Offboarding can't be completed yet");
      await assertA11y(page);
      await shot(page, `lifecycle-complete-blocked-${viewport.label}`);

      expect(api.unhandled).toEqual([]);
    });
  }
});

test.describe('builder lifecycle — paused screen (#861)', () => {
  for (const viewport of VIEWPORTS) {
    test(`403 BUILDER_PAUSED shows the paused screen @ ${viewport.label}`, async ({ page }) => {
      await prepare(page, viewport.width, viewport.height);
      await mockBuilderApi(page, { signedIn: true });
      await page.route('**/api/v1/builder/leads**', (route) =>
        json(route, { code: 'BUILDER_PAUSED', message: PAUSED_MESSAGE }, 403),
      );

      await page.goto('/builder');
      const screen = page.getByTestId('account-paused');
      await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Your account is paused');
      await expect(screen).toContainText(PAUSED_MESSAGE);
      await expect(screen.getByTestId('paused-contact')).toHaveAttribute('href', '/builder/settings?tab=help');
      await assertA11y(page);
      await shot(page, `builder-paused-${viewport.label}`);

      await screen.getByTestId('paused-contact').click();
      await expect(page).toHaveURL(/\/builder\/settings\?tab=help/);
      await expect(page.getByTestId('account-paused')).toHaveCount(0);
      await expect(page.getByTestId('close-account')).toBeVisible();
    });
  }
});
