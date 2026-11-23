/**
 * Admin Builder partners page (#919): list, add, edit, activate/deactivate
 * and reorder, end to end through AdminPartnersState and the real
 * AdminPartnersApiService against HTTP mocks. Every change toasts.
 */
import { InteractivityChecker } from '@angular/cdk/a11y';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminBuilderPartner } from '@feasly/contracts';
import { UiToastService } from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { AdminAuthState } from './admin-auth.state';
import { AdminPartnersComponent } from './admin-partners.component';
import { AdminPartnersState } from './admin-partners.state';
import { ADMIN_PERMISSIONS } from './admin-permissions';

const BASE = {
  logoUrl: null,
  builderId: null,
  createdAt: '2026-11-15T00:00:00.000Z',
  updatedAt: '2026-11-15T00:00:00.000Z',
} as const;

const ELITE: AdminBuilderPartner = {
  ...BASE,
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Elite Craft Builders',
  websiteUrl: 'https://elitecraftbuilders.com',
  description: null,
  displayOrder: 0,
  active: true,
};
const NORTH: AdminBuilderPartner = {
  ...BASE,
  id: '00000000-0000-4000-8000-000000000002',
  name: 'North Homes',
  websiteUrl: null,
  description: 'Northwest infills.',
  displayOrder: 1,
  active: false,
};
const RIVER: AdminBuilderPartner = {
  ...BASE,
  id: '00000000-0000-4000-8000-000000000003',
  name: 'River Builders',
  websiteUrl: null,
  description: null,
  displayOrder: 2,
  active: true,
};

const LIST = '/api/v1/admin/partners';
const one = (id: string) => `${LIST}/${id}`;

/** jsdom has no layout, so the CDK sees nothing as visible: treat enabled controls as tabbable. */
const checkerStub: Partial<InteractivityChecker> = {
  isFocusable: (el: HTMLElement) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0,
  isTabbable: (el: HTMLElement) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0,
  isVisible: () => true,
  isDisabled: (el: HTMLElement) => !!(el as HTMLButtonElement).disabled,
};

/** Poll (with a deadline) for an async UI state — never a fixed sleep. */
async function until(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    TestBed.tick();
  }
}

describe('AdminPartnersComponent (#919)', () => {
  let fixture: ComponentFixture<AdminPartnersComponent>;
  let store: Store;
  let http: HttpTestingController;
  let toast: ReturnType<typeof vi.fn>;

  async function setup(permissions: string[] = [ADMIN_PERMISSIONS.buildersManage]): Promise<void> {
    TestBed.resetTestingModule();
    toast = vi.fn().mockReturnValue({ id: 1, dismissed: { subscribe: () => undefined }, dismiss: () => undefined });
    TestBed.configureTestingModule({
      imports: [AdminPartnersComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '**', children: [] }]),
        provideLocationMocks(),
        { provide: InteractivityChecker, useValue: checkerStub },
        { provide: UiToastService, useValue: { show: toast } },
        ConfigService,
        provideStore([AdminPartnersState, AdminAuthState]),
      ],
    });
    const config = TestBed.inject(ConfigService);
    http = TestBed.inject(HttpTestingController);
    const pending = config.load();
    http.expectOne('/assets/config/app-config.json').flush({ api: { useMockApi: false } });
    await pending;
    store = TestBed.inject(Store);
    store.reset({
      ...store.snapshot(),
      adminAuth: { ...store.selectSnapshot((s) => s.adminAuth), permissions },
    });
    fixture = TestBed.createComponent(AdminPartnersComponent);
    document.body.appendChild(fixture.nativeElement as HTMLElement);
  }

  function expectReq(method: string, path: string) {
    const req = http.expectOne((r) => r.method === method && r.url.endsWith(path));
    expect(req.request.withCredentials).toBe(true);
    return req;
  }

  function flushList(partners: AdminBuilderPartner[] = [ELITE, NORTH, RIVER]): void {
    fixture.detectChanges();
    expectReq('GET', LIST).flush({ partners });
    fixture.detectChanges();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byTestId = (id: string): HTMLButtonElement | null =>
    el().querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  const drawer = (): HTMLElement | null =>
    document.querySelector('.ui-drawer-pane app-admin-partner-drawer');

  function rowNames(): string[] {
    return (store.selectSnapshot(AdminPartnersState.partners) ?? []).map((p) => p.name);
  }

  function type(scope: HTMLElement, testId: string, value: string): void {
    const field = scope.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-testid="${testId}"] input, textarea[data-testid="${testId}"]`,
    )!;
    expect(field, testId).not.toBeNull();
    field.value = value;
    field.dispatchEvent(new Event('input'));
    field.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
  }

  /** Open a row's ⋮ menu and pick an item (rendered in the CDK overlay). */
  async function chooseMenu(partner: AdminBuilderPartner, label: string): Promise<void> {
    const trigger = el().querySelector<HTMLButtonElement>(
      `[aria-label="Actions for ${partner.name}"]`,
    );
    expect(trigger, `menu for ${partner.name}`).not.toBeNull();
    trigger!.click();
    fixture.detectChanges();
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('.row-actions__item')).find(
      (i) => i.querySelector('.row-actions__label')?.textContent?.trim() === label,
    );
    expect(item, `menu item ${label}`).toBeDefined();
    item!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    await setup();
  });

  afterEach(() => {
    http.verify();
    fixture.destroy();
    document.querySelectorAll('.cdk-overlay-container').forEach((n) => (n.innerHTML = ''));
  });

  it('lists every partner in display order with an active count', () => {
    flushList([RIVER, NORTH, ELITE]);
    expect(rowNames()).toEqual(['Elite Craft Builders', 'North Homes', 'River Builders']);
    expect(byTestId('partners-count')!.textContent!.trim()).toBe('2 of 3 active');
    expect(el().textContent).toContain('Elite Craft Builders');
    expect(el().querySelector('a[href="https://elitecraftbuilders.com"]')).not.toBeNull();
  });

  it('shows a retryable error when the list fails', () => {
    fixture.detectChanges();
    expectReq('GET', LIST).flush({ message: 'Down.' }, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(el().textContent).toContain("Couldn't load partners");
    const retry = Array.from(el().querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Retry')!;
    retry.click();
    expectReq('GET', LIST).flush({ partners: [ELITE] });
    fixture.detectChanges();
    expect(rowNames()).toEqual(['Elite Craft Builders']);
  });

  it('hides write controls from sessions without builders:manage', async () => {
    fixture.destroy();
    await setup([]);
    flushList();
    expect(byTestId('add-partner')).toBeNull();
    expect(byTestId(`move-up-${NORTH.id}`)).toBeNull();
    expect(el().querySelector(`[aria-label="Actions for ${ELITE.name}"]`)).toBeNull();
  });

  it('adds a partner through the drawer (POST) and toasts', async () => {
    flushList();
    byTestId('add-partner')!.click();
    fixture.detectChanges();
    await until(() => drawer() !== null, 'drawer opens');
    const d = drawer()!;
    expect(d.querySelector('.ui-drawer__title')!.textContent!.trim()).toBe('Add partner');

    type(d, 'partner-name', '  Prairie Infill Co  ');
    type(d, 'partner-website', 'https://prairie.example');
    type(d, 'partner-description', 'Altadore and Killarney.');
    (d.querySelector('[data-testid="partner-save"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const req = expectReq('POST', LIST);
    expect(req.request.body).toEqual({
      name: 'Prairie Infill Co',
      logoUrl: null,
      websiteUrl: 'https://prairie.example',
      description: 'Altadore and Killarney.',
      active: true,
    });
    req.flush({
      ...BASE,
      id: '00000000-0000-4000-8000-000000000004',
      name: 'Prairie Infill Co',
      websiteUrl: 'https://prairie.example',
      description: 'Altadore and Killarney.',
      displayOrder: 3,
      active: true,
    });
    await until(() => drawer() === null, 'drawer closes after save');
    fixture.detectChanges();
    expect(rowNames()).toContain('Prairie Infill Co');
    expect(toast).toHaveBeenCalledWith({ message: 'Prairie Infill Co added.' });
  });

  it('blocks a non-https URL and an empty name before calling the API', async () => {
    flushList();
    byTestId('add-partner')!.click();
    fixture.detectChanges();
    await until(() => drawer() !== null, 'drawer opens');
    const d = drawer()!;
    type(d, 'partner-website', 'http://insecure.example');
    (d.querySelector('[data-testid="partner-save"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(d.textContent).toContain('Enter the company name.');
    expect(d.textContent).toContain('Enter a full https:// address.');
    http.expectNone((r) => r.method === 'POST');
  });

  it('edits a partner with a PATCH of only the changed fields, and toasts', async () => {
    flushList();
    await chooseMenu(NORTH, 'Edit');
    await until(() => drawer() !== null, 'drawer opens');
    const d = drawer()!;
    expect(d.querySelector('.ui-drawer__title')!.textContent!.trim()).toBe('Edit North Homes');

    type(d, 'partner-description', '');
    type(d, 'partner-logo', 'https://cdn.example/north.png');
    (d.querySelector('[data-testid="partner-save"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const req = expectReq('PATCH', one(NORTH.id));
    expect(req.request.body).toEqual({ logoUrl: 'https://cdn.example/north.png', description: null });
    req.flush({ ...NORTH, logoUrl: 'https://cdn.example/north.png', description: null });
    await until(() => drawer() === null, 'drawer closes after save');
    expect(store.selectSnapshot(AdminPartnersState.partners)[1]!.logoUrl).toBe('https://cdn.example/north.png');
    expect(toast).toHaveBeenCalledWith({ message: 'North Homes saved.' });
  });

  it('keeps the drawer open with the backend message when a save fails', async () => {
    flushList();
    await chooseMenu(ELITE, 'Edit');
    await until(() => drawer() !== null, 'drawer opens');
    const d = drawer()!;
    type(d, 'partner-name', 'Elite Craft');
    (d.querySelector('[data-testid="partner-save"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expectReq('PATCH', one(ELITE.id)).flush(
      { code: 'validation_failed', message: 'Name is taken.' },
      { status: 400, statusText: 'Bad Request' },
    );
    fixture.detectChanges();
    await until(() => !!d.querySelector('[data-testid="partner-save-error"]'), 'error shows');
    expect(d.querySelector('[data-testid="partner-save-error"]')!.textContent).toContain('Name is taken.');
    expect(drawer()).not.toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it('deactivates a partner (PATCH active=false) with an Undo toast that reactivates it', async () => {
    flushList();
    await chooseMenu(ELITE, 'Deactivate');
    const req = expectReq('PATCH', one(ELITE.id));
    expect(req.request.body).toEqual({ active: false });
    req.flush({ ...ELITE, active: false });
    fixture.detectChanges();
    expect(store.selectSnapshot(AdminPartnersState.partners)[0]!.active).toBe(false);
    expect(byTestId('partners-count')!.textContent!.trim()).toBe('1 of 3 active');
    const options = toast.mock.calls[0]![0] as { message: string; undo?: () => void };
    expect(options.message).toBe('Elite Craft Builders is hidden from the public partner list.');

    options.undo!();
    const undo = expectReq('PATCH', one(ELITE.id));
    expect(undo.request.body).toEqual({ active: true });
    undo.flush(ELITE);
    expect(store.selectSnapshot(AdminPartnersState.partners)[0]!.active).toBe(true);
    const second = toast.mock.calls[1]![0] as { message: string; undo?: () => void };
    expect(second.message).toBe('Elite Craft Builders is now in the public partner list.');
    expect(second.undo).toBeUndefined();
  });

  it('activates an inactive partner and toasts a failure in danger tone', async () => {
    flushList();
    await chooseMenu(NORTH, 'Activate');
    expectReq('PATCH', one(NORTH.id)).flush(
      { code: 'forbidden', message: 'You do not have permission.' },
      { status: 403, statusText: 'Forbidden' },
    );
    expect(toast).toHaveBeenCalledWith({ message: 'You do not have permission.', tone: 'danger' });
    expect(store.selectSnapshot(AdminPartnersState.busyId)).toBeNull();
  });

  it('moves a partner up: renumbers the changed rows, reloads, and toasts', () => {
    flushList();
    expect(byTestId(`move-up-${ELITE.id}`)!.disabled).toBe(true);
    expect(byTestId(`move-down-${RIVER.id}`)!.disabled).toBe(true);

    byTestId(`move-up-${RIVER.id}`)!.click();
    fixture.detectChanges();
    // Renumbered top-down, one request at a time: River → 1, then North → 2.
    const first = expectReq('PATCH', one(RIVER.id));
    expect(first.request.body).toEqual({ displayOrder: 1 });
    http.expectNone((r) => r.url.endsWith(one(NORTH.id)));
    first.flush({ ...RIVER, displayOrder: 1 });
    const second = expectReq('PATCH', one(NORTH.id));
    expect(second.request.body).toEqual({ displayOrder: 2 });
    second.flush({ ...NORTH, displayOrder: 2 });

    expectReq('GET', LIST).flush({
      partners: [ELITE, { ...RIVER, displayOrder: 1 }, { ...NORTH, displayOrder: 2 }],
    });
    fixture.detectChanges();
    expect(rowNames()).toEqual(['Elite Craft Builders', 'River Builders', 'North Homes']);
    expect(toast).toHaveBeenCalledWith({ message: 'River Builders moved up.' });
  });

  it('renumbers tied display orders so a move always takes effect', () => {
    flushList([
      { ...ELITE, displayOrder: 0 },
      { ...NORTH, displayOrder: 0 },
    ]);
    // Ties sort by name: Elite, North. Move North up → North 0, Elite 1.
    byTestId(`move-up-${NORTH.id}`)!.click();
    const req = expectReq('PATCH', one(ELITE.id));
    expect(req.request.body).toEqual({ displayOrder: 1 });
    req.flush({ ...ELITE, displayOrder: 1 });
    expectReq('GET', LIST).flush({ partners: [{ ...NORTH, displayOrder: 0 }, { ...ELITE, displayOrder: 1 }] });
    expect(rowNames()).toEqual(['North Homes', 'Elite Craft Builders']);
  });

  it('reloads and toasts the error when a reorder PATCH fails', () => {
    flushList();
    byTestId(`move-down-${ELITE.id}`)!.click();
    // The first renumber (North → 0) fails; the rest are not sent.
    expectReq('PATCH', one(NORTH.id)).flush(
      { message: 'displayOrder must be an integer 0–10000.' },
      { status: 400, statusText: 'Bad Request' },
    );
    expectReq('GET', LIST).flush({ partners: [ELITE, NORTH, RIVER] });
    expect(toast).toHaveBeenCalledWith({
      message: 'displayOrder must be an integer 0–10000.',
      tone: 'danger',
    });
    expect(store.selectSnapshot(AdminPartnersState.busyId)).toBeNull();
  });
});
