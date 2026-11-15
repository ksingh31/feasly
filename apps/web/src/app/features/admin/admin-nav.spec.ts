/**
 * Admin nav model (#503): every routed admin section is reachable from the
 * sidebar, and URLs resolve to the right group/section for breadcrumbs.
 */
import { describe, expect, it } from 'vitest';
import { routes } from '../../app.routes';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { ADMIN_NAV, findAdminNavItem } from './admin-nav';

/** Child paths of the /admin shell route that are not nav destinations. */
const NOT_IN_NAV = new Set(['', 'error']);

describe('ADMIN_NAV', () => {
  const adminRoute = routes.find((route) => route.path === 'admin');

  it('covers every admin shell child route', () => {
    expect(adminRoute?.children?.length).toBeGreaterThan(0);
    const navPaths = ADMIN_NAV.flatMap((group) => group.items.map((item) => item.path));
    const uncovered = (adminRoute?.children ?? [])
      .map((child) => child.path ?? '')
      .filter((path) => !NOT_IN_NAV.has(path))
      .filter((path) => findAdminNavItem(`/admin/${path.replace(/:[^/]+/g, 'x')}`) === null);
    expect(uncovered).toEqual([]);
    // Every nav destination is a real route.
    const routed = new Set((adminRoute?.children ?? []).map((child) => `/admin/${child.path}`));
    expect(navPaths.filter((path) => !routed.has(path))).toEqual([]);
  });

  it('keeps the admin error state inside the shell route', () => {
    expect(adminRoute?.children?.some((child) => child.path === 'error')).toBe(true);
  });

  it('has a configured label for every group and item', () => {
    const copy = DEFAULT_APP_CONFIG.copy.admin.shell;
    for (const group of ADMIN_NAV) {
      expect(copy.groups[group.id]).toBeTruthy();
      for (const item of group.items) expect(copy.nav[item.id]).toBeTruthy();
    }
  });
});

describe('findAdminNavItem', () => {
  it.each([
    ['/admin/leads', 'pipeline', 'leads'],
    ['/admin/leads?status=new', 'pipeline', 'leads'],
    ['/admin/quarantine', 'pipeline', 'quarantine'],
    ['/admin/estimates/abc', 'pipeline', 'estimates'],
    ['/admin/billing', 'money', 'billing'],
    ['/admin/billing/invoices', 'money', 'invoices'],
    ['/admin/billing/invoices/inv-1', 'money', 'invoices'],
    ['/admin/ops/sheets', 'system', 'sheets'],
    ['/admin/webhooks', 'system', 'webhooks'],
    ['/admin/api-keys/', 'partners', 'apiKeys'],
  ])('%s → %s / %s', (url, group, item) => {
    const match = findAdminNavItem(url);
    expect(match?.group.id).toBe(group);
    expect(match?.item.id).toBe(item);
  });

  it('returns null outside the nav', () => {
    expect(findAdminNavItem('/admin/error')).toBeNull();
    expect(findAdminNavItem('/admin/leadsx')).toBeNull();
  });
});
