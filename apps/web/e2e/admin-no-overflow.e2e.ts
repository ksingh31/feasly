/**
 * #548: admin visual QA. Re-runs the 2026-11-13 admin screenshot audit
 * (docs/reviews/2026-11-13-admin.md) as a repeatable gate.
 *
 * For every route in ADMIN_E2E_ROUTES at 1440×900 and 390×844:
 *   - the page settles (ready selector visible, no skeletons),
 *   - `document.documentElement.scrollWidth <= window.innerWidth`,
 *   - axe reports zero critical/serious violations,
 *   - every API call was answered by a fixture (no silent 404s).
 *
 * For every drawer / modal in ADMIN_E2E_OVERLAYS, at both viewports:
 *   - the same overflow + axe checks with the overlay open,
 *   - keyboard path: focus is inside the dialog, Tab and Shift+Tab stay
 *     trapped inside it, Escape closes it.
 *
 * The real-browser counterpart of the static guard in
 * tools/mobile-tables.spec.ts (jsdom can't measure layout).
 * `E2E_SCREENSHOTS=1` writes the 1440 / 390 captures for PR evidence.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mockAdminApi } from './admin-api-fixtures';
import { ADMIN_E2E_OVERLAYS, ADMIN_E2E_ROUTES } from './admin-routes';
import type { AdminE2eOverlay, AdminE2eRoute } from './admin-routes';

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '390', width: 390, height: 844 },
] as const;
type Viewport = (typeof VIEWPORTS)[number];

const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');
const takeScreenshots = process.env['E2E_SCREENSHOTS'] === '1';

/** The topmost open dialog (drawers and modals both carry role="dialog"). */
const DIALOG = '[role="dialog"]:visible';

/** Tab presses used to probe the focus trap (more than any overlay's tab stops would need to escape). */
const TAB_PROBES = 40;

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

/** Seed the analytics choice so the fixed consent banner doesn't cover the page. */
async function seedConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('consent', JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }));
  });
}

async function settle(page: Page, ready: string): Promise<void> {
  await expect(page.locator(ready).first()).toBeVisible();
  await expect(page.locator('ui-skeleton')).toHaveCount(0);
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
    // animations: 'disabled' finishes CSS transitions first — the full-page
    // capture resizes the viewport, which can catch the sidebar's width
    // transition mid-flight and misreport the layout.
    await page.screenshot({ path: join(SCREENSHOT_DIR, `${shotName}.png`), fullPage, animations: 'disabled' });
  }
}

/** True when the focused element sits inside the topmost open dialog. */
function focusInsideDialog(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
      (d) => d.getClientRects().length > 0,
    );
    const top = dialogs[dialogs.length - 1];
    const active = document.activeElement;
    return !!top && !!active && top.contains(active);
  });
}

async function assertKeyboardPath(page: Page): Promise<void> {
  // Focus moves into the dialog when it opens (initial focus).
  await expect.poll(() => focusInsideDialog(page), { message: 'focus moves into the dialog' }).toBe(true);

  // Tab and Shift+Tab cycle inside the dialog: never reach the page behind.
  for (const key of ['Tab', 'Shift+Tab'] as const) {
    for (let i = 0; i < TAB_PROBES; i++) {
      await page.keyboard.press(key);
      expect(await focusInsideDialog(page), `${key} #${i + 1} keeps focus inside the dialog`).toBe(true);
    }
  }

  // Escape closes it.
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toHaveCount(0);
}

function visit(route: AdminE2eRoute, viewport: Viewport): void {
  test(`${route.url} @ ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await seedConsent(page);
    const api = await mockAdminApi(page, { signedIn: !route.public });
    await page.goto(route.url);
    await settle(page, route.ready);
    await assertNoOverflowAndA11y(page, `admin-${route.name}-${viewport.label}`);
    expect(api.unhandled, 'API calls with no fixture').toEqual([]);
  });
}

function overlay(o: AdminE2eOverlay, viewport: Viewport): void {
  test(`${o.name} @ ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await seedConsent(page);
    const api = await mockAdminApi(page, { signedIn: true });
    await page.goto(o.url);
    await settle(page, '#admin-main h1');
    if (o.trigger) {
      await page.locator('#admin-main').getByRole('button', { name: o.trigger, exact: true }).first().click();
    }
    await settle(page, DIALOG);
    // Viewport capture: overlays are fixed, a full-page shot misleads.
    await assertNoOverflowAndA11y(page, `admin-${o.name}-${viewport.label}`, false);
    await assertKeyboardPath(page);
    expect(api.unhandled, 'API calls with no fixture').toEqual([]);
  });
}

test.describe('admin console: no horizontal overflow, axe, keyboard paths (#548)', () => {
  for (const viewport of VIEWPORTS) {
    for (const route of ADMIN_E2E_ROUTES) {
      visit(route, viewport);
    }
    for (const o of ADMIN_E2E_OVERLAYS) {
      overlay(o, viewport);
    }
  }
});
