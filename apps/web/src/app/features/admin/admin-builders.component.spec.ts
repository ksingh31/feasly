/**
 * Admin Builders page (#541, review S7): the narrow kit DataTable
 * (name + slug, status, plan, rate, payment method), empty / error
 * states, the builder drawer opened from a row, "Edit", "Add builder"
 * and `?open=<id>` deep links, and viewer gating.
 */
import { TestBed } from '@angular/core/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { Router, provideRouter } from '@angular/router';
import { Store, provideStore } from '@ngxs/store';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { Builder, BuilderListResponse } from '@feasly/contracts';
import { UiDrawerService } from '@app/shared/ui';
import { AdminBuildersComponent } from './admin-builders.component';
import { AdminBuilderDrawerComponent } from './admin-builder-drawer.component';
import { AdminBuildersApiService } from './admin-builders-api.service';
import { AdminBuildersState } from './admin-builders.state';
import { AdminAuthState } from './admin-auth.state';
import { ADMIN_PERMISSIONS } from './admin-permissions';

const BUILDER_A: Builder = {
  id: 'b1',
  tenantKey: 'elite-craft',
  businessName: 'Elite Craft Builders',
  displayName: 'Elite Craft',
  email: 'hello@elite.example',
  phone: null,
  logoUrl: null,
  accentColor: '#C8A24B',
  allowedOrigins: ['elite.example'],
  plan: 'flat',
  status: 'active',
  settings: {},
  commissionRatePercent: 1,
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};

const BUILDER_B: Builder = {
  ...BUILDER_A,
  id: 'b2',
  tenantKey: 'bow-river-custom',
  businessName: 'Bow River Custom Homes',
  displayName: 'Bow River',
  email: null,
  plan: null,
  status: 'inactive',
  commissionRatePercent: 1.25,
  settings: { defaultPaymentMethod: 'e_transfer' },
};

interface Options {
  readonly builders?: Builder[];
  readonly listFails?: boolean;
  readonly canManage?: boolean;
  readonly url?: string;
  readonly list?: Subject<BuilderListResponse>;
}

async function setup(options: Options = {}) {
  const api = {
    listBuilders: vi.fn(() =>
      options.list
        ? options.list.asObservable()
        : options.listFails
          ? throwError(() => ({ message: 'Could not load builders.' }))
          : of({ builders: options.builders ?? [BUILDER_A, BUILDER_B] }),
    ),
  };
  const drawerOpen = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AdminBuildersComponent],
    providers: [
      provideRouter([{ path: '**', component: AdminBuildersComponent }]),
      provideLocationMocks(),
      provideStore([AdminBuildersState, AdminAuthState]),
      { provide: AdminBuildersApiService, useValue: api },
      { provide: UiDrawerService, useValue: { open: drawerOpen, openDrawer: null } },
    ],
  });
  const store = TestBed.inject(Store);
  store.reset({
    ...store.snapshot(),
    adminAuth: {
      ...store.selectSnapshot((s) => s.adminAuth),
      permissions: options.canManage === false ? [] : [ADMIN_PERMISSIONS.buildersManage],
    },
  });
  await TestBed.inject(Router).navigateByUrl(options.url ?? '/admin/builders');
  const fixture = TestBed.createComponent(AdminBuildersComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { api, drawerOpen, store, fixture, el };
}

/** Poll (with a deadline) for an async UI state — never a fixed sleep. */
async function until(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    TestBed.tick();
  }
}

const rows = (el: HTMLElement) => Array.from(el.querySelectorAll('.ui-dt__table tbody tr')) as HTMLElement[];
const text = (node: Element) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('AdminBuildersComponent (#541)', () => {
  it('renders the narrow table: name + slug, status, plan, rate, payment method', async () => {
    const { el } = await setup();
    const headers = Array.from(el.querySelectorAll('.ui-dt__table thead th')).map(text);
    expect(headers.slice(0, 6)).toEqual(['Builder', 'Status', 'Plan', 'Rate', 'Payment method', 'Email']);

    const [a, b] = rows(el);
    expect(a.querySelector('.builders-page__name')?.textContent).toBe('Elite Craft Builders');
    expect(a.querySelector('.builders-page__slug')?.textContent).toBe('elite-craft');
    expect(text(a)).toContain('Active');
    expect(text(a)).toContain('Flat');
    expect(text(a)).toContain('1%');
    expect(text(a)).toContain('Card auto');
    expect(text(a)).toContain('hello@elite.example');

    expect(b.querySelector('.builders-page__slug')?.textContent).toBe('bow-river-custom');
    expect(text(b)).toContain('Inactive');
    expect(text(b)).toContain('Undecided');
    expect(text(b)).toContain('1.25%');
    expect(text(b)).toContain('E-transfer');
  });

  it('shows initials when the builder has no logo', async () => {
    const { el } = await setup();
    expect(rows(el)[0].querySelector('.builders-page__avatar')?.textContent?.trim()).toBe('EB');
  });

  it('shows the empty state when there are no builders', async () => {
    const { el } = await setup({ builders: [] });
    expect(text(el.querySelector('ui-empty-state')!)).toContain('No builders yet');
  });

  it('shows the error state and reloads on retry', async () => {
    const { el, api } = await setup({ listFails: true });
    expect(text(el.querySelector('ui-error-state')!)).toContain('Could not load builders.');
    const retry = Array.from(el.querySelectorAll('ui-error-state button')).find(
      (b) => text(b) === 'Try again',
    ) as HTMLButtonElement;
    retry.click();
    expect(api.listBuilders).toHaveBeenCalledTimes(2);
  });

  it('opens the builder drawer from a row click and from Edit', async () => {
    const { el, drawerOpen } = await setup();
    rows(el)[1].click();
    expect(drawerOpen).toHaveBeenCalledWith(
      AdminBuilderDrawerComponent,
      expect.objectContaining({ data: { builderId: 'b2' }, urlId: 'b2', size: 'lg' }),
    );

    (rows(el)[0].querySelector('[data-testid="edit-builder"]') as HTMLButtonElement).click();
    expect(drawerOpen).toHaveBeenLastCalledWith(
      AdminBuilderDrawerComponent,
      expect.objectContaining({ data: { builderId: 'b1' }, urlId: 'b1' }),
    );
  });

  it('opens a blank drawer (no URL id) from Add builder', async () => {
    const { el, drawerOpen } = await setup();
    (el.querySelector('[data-testid="add-builder"]') as HTMLButtonElement).click();
    const [component, options] = drawerOpen.mock.calls[0];
    expect(component).toBe(AdminBuilderDrawerComponent);
    expect(options.data).toEqual({ builderId: null });
    expect(options).not.toHaveProperty('urlId');
  });

  it('opens the drawer from a ?open=<id> deep link once the rows load', async () => {
    const list = new Subject<BuilderListResponse>();
    const { drawerOpen } = await setup({ url: '/admin/builders?open=b2', list });
    expect(drawerOpen).not.toHaveBeenCalled();
    list.next({ builders: [BUILDER_A, BUILDER_B] });
    list.complete();
    await until(() => drawerOpen.mock.calls.length === 1, 'deep-link drawer');
    expect(drawerOpen.mock.calls[0][1]).toMatchObject({ data: { builderId: 'b2' }, urlId: 'b2' });
  });

  it('drops a ?open= id that names no builder', async () => {
    const { drawerOpen } = await setup({ url: '/admin/builders?open=nope' });
    const router = TestBed.inject(Router);
    await until(() => !router.url.includes('open='), 'param dropped');
    expect(drawerOpen).not.toHaveBeenCalled();
  });

  it('reflects a saved builder in the table without a reload', async () => {
    const { el, store } = await setup();
    store.reset({
      ...store.snapshot(),
      adminBuilders: {
        ...store.selectSnapshot((s) => s.adminBuilders),
        builders: [{ ...BUILDER_A, commissionRatePercent: 1.5 }, BUILDER_B],
      },
    });
    await until(() => text(rows(el)[0]).includes('1.5%'), 'rate updates');
  });

  describe('viewer permission gating (QA admin-console finding 8)', () => {
    it('hides Add and Edit from viewers, keeps the table, and never opens the drawer', async () => {
      const { el, drawerOpen } = await setup({ canManage: false, url: '/admin/builders?open=b1' });
      expect(text(el)).toContain('Elite Craft Builders');
      expect(el.querySelector('[data-testid="add-builder"]')).toBeNull();
      expect(el.querySelector('[data-testid="edit-builder"]')).toBeNull();
      rows(el)[0].click();
      expect(drawerOpen).not.toHaveBeenCalled();
    });
  });

  it('loads the builders on init', async () => {
    const { api, store } = await setup();
    expect(api.listBuilders).toHaveBeenCalledTimes(1);
    expect(store.selectSnapshot(AdminBuildersState.builders)).toHaveLength(2);
  });
});
