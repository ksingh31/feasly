/**
 * #476 guard: the wide admin / builder tables stack into cards on phones.
 *
 * jsdom has no layout engine, so it can't measure `scrollWidth`. Instead
 * this spec checks the two things the stacked-card layout relies on:
 *   1. the table's stylesheet includes the shared `feasly-stacked-table`
 *      mixin (it hides the header row and stacks cells at <= 640px), and
 *   2. every body data cell in the template carries a `data-label` (static
 *      or `[attr.data-label]`), so each stacked value keeps its column name.
 * The only cells allowed to skip the label are row-action cells and
 * colspan empty-state rows.
 *
 * Real-browser check (390x844 and 1440x900, scrollWidth <= innerWidth on
 * every route) is recorded in the PR for #476. The Playwright harness that
 * will run it in CI is tracked in #536.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FEATURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'features');

interface TableCase {
  readonly route: string;
  readonly template: string;
  readonly stylesheet: string;
  readonly tableClass: string;
}

const CASES: readonly TableCase[] = [
  { route: '/admin/builders', template: 'admin/admin-builders.component.html', stylesheet: 'admin/admin-builders.component.scss', tableClass: 'builders-page__table' },
  { route: '/admin/users', template: 'admin/admin-users.component.html', stylesheet: 'admin/admin-users.component.scss', tableClass: 'users-page__table' },
  { route: '/admin/calibration', template: 'admin/admin-calibration.component.html', stylesheet: 'admin/admin-calibration.component.scss', tableClass: 'calibration__table' },
  { route: '/admin/api-keys', template: 'admin/api-key-usage.component.html', stylesheet: 'admin/api-key-usage.component.scss', tableClass: 'usage__table' },
  { route: '/builder/invoices', template: 'builder/builder-invoices.component.html', stylesheet: 'builder/builder-invoices.component.scss', tableClass: 'builder-invoices__table' },
  { route: '/builder/team', template: 'builder/builder-team.component.html', stylesheet: 'builder/builder-team.component.scss', tableClass: 'builder-team__table' },
];

/** Opening tags of body cells (`<td …>` / `<th scope="row" …>`) inside every `<tbody>`. */
function bodyCellTags(html: string): string[] {
  const tags: string[] = [];
  for (const body of html.match(/<tbody[\s\S]*?<\/tbody>/g) ?? []) {
    for (const tag of body.match(/<t[dh](?:\s[^>]*)?>/g) ?? []) {
      tags.push(tag);
    }
  }
  return tags;
}

function isExempt(tag: string): boolean {
  return /colspan/.test(tag) || /__actions/.test(tag) || /__skeleton/.test(tag);
}

/** Cells inside skeleton rows (loading placeholders) carry no data. */
function stripSkeletonRows(html: string): string {
  return html.replace(/<tr class="[^"]*__skeleton-row"[\s\S]*?<\/tr>/g, '');
}

describe('#476 mobile tables stack into labelled cards', () => {
  for (const c of CASES) {
    describe(c.route, () => {
      const html = stripSkeletonRows(readFileSync(join(FEATURES, c.template), 'utf8'));
      const scss = readFileSync(join(FEATURES, c.stylesheet), 'utf8');

      it('includes the shared stacked-table mixin on the table', () => {
        expect(scss).toContain("@use '../../shared/stacked-table'");
        const rule = scss.match(new RegExp(`\\.${c.tableClass}\\s*\\{([\\s\\S]*?)\\n\\}`));
        expect(rule, `.${c.tableClass} rule`).not.toBeNull();
        expect(rule![1]).toContain('@include feasly-stacked-table');
      });

      it('labels every body data cell', () => {
        const cells = bodyCellTags(html);
        expect(cells.length).toBeGreaterThan(0);
        const unlabelled = cells.filter((tag) => !isExempt(tag) && !/data-label/.test(tag));
        expect(unlabelled).toEqual([]);
      });
    });
  }
});
