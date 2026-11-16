/**
 * #864 (#725 AC6): the Leads unread badge in the builder shell.
 *
 * Seeds the last Leads visit (NGXS storage key `builderLeadsSeen`) between
 * the fixture leads' arrival times, then checks — at 1440×900 and 390×844 —
 * that the badge shows the count away from Leads, axe reports nothing
 * critical/serious, and opening Leads clears it.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LEAD_LIST, mockBuilderApi } from './builder-api-fixtures';

const SCREENSHOT_DIR = join(__dirname, '..', 'e2e-results', 'screenshots');

const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900, badge: '[data-testid="leads-badge"]' },
  { label: '390', width: 390, height: 844, badge: '[data-testid="leads-badge-tab"]' },
] as const;

/** Halfway between the 3rd and 4th newest fixture lead. */
function lastSeenBetweenLeads(): { at: string; unread: number } {
  const times = LEAD_LIST.leads.map((l) => Date.parse(l.createdAt)).sort((a, b) => b - a);
  return { at: new Date((times[2] + times[3]) / 2).toISOString(), unread: 3 };
}

for (const viewport of VIEWPORTS) {
  test(`Leads unread badge shows and clears on visit @ ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const seen = lastSeenBetweenLeads();
    await page.addInitScript((at) => {
      window.localStorage.setItem(
        'consent',
        JSON.stringify({ status: 'declined', consentTs: '2026-11-01T00:00:00.000Z' }),
      );
      window.localStorage.setItem(
        'builderLeadsSeen',
        JSON.stringify({ lastSeenAt: { 'elite-craft-builders': at } }),
      );
    }, seen.at);
    const api = await mockBuilderApi(page, { signedIn: true });

    await page.goto('/builder/settings');
    const badge = page.locator(viewport.badge);
    await expect(badge).toHaveText(String(seen.unread));

    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = axe.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(serious.map((v) => v.id)).toEqual([]);
    if (process.env['E2E_SCREENSHOTS'] === '1') {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(SCREENSHOT_DIR, `builder-leads-badge-${viewport.label}.png`) });
    }

    // Open Leads: the badge clears, and stays cleared after leaving again.
    const nav = viewport.label === '390' ? '.builder-shell__tabs' : '.builder-shell__nav';
    await page.locator(`${nav} a[href="/builder"]`).click();
    await expect(page).toHaveURL(/\/builder$/);
    await expect(badge).toHaveCount(0);
    await page.locator(`${nav} a[href="/builder/settings"]`).click();
    await expect(page).toHaveURL(/\/builder\/settings/);
    await expect(badge).toHaveCount(0);

    expect(api.unhandled, 'API calls with no fixture').toEqual([]);
  });
}
