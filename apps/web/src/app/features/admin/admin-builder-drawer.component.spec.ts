/**
 * Admin builder drawer (#541, review S7): sections, locked sign-in key,
 * commission-rate before → after (AC1), the settings JSON behind an
 * "Advanced" disclosure with validation (AC2), create/update payloads,
 * and the save-error path.
 */
import { DIALOG_DATA } from '@angular/cdk/dialog';
import { TestBed } from '@angular/core/testing';
import { Store, provideStore } from '@ngxs/store';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { Builder, BuilderCreateBody, BuilderUpdateBody } from '@feasly/contracts';
import { UiDrawerRef, UiToastService } from '@app/shared/ui';
import { AdminBuilderDrawerComponent } from './admin-builder-drawer.component';
import { AdminBuildersApiService } from './admin-builders-api.service';
import { AdminBuildersState } from './admin-builders.state';
import { LoadBuilders } from './admin-builders.actions';

const BUILDER: Builder = {
  id: 'b1',
  tenantKey: 'elite-craft',
  businessName: 'Elite Craft Builders',
  displayName: 'Elite Craft',
  email: 'hello@elite.example',
  phone: null,
  logoUrl: null,
  accentColor: '#C8A24B',
  allowedOrigins: ['elite.example', 'www.elite.example'],
  plan: 'flat',
  status: 'active',
  settings: { defaultPaymentMethod: 'e_transfer', theme: 'dark' },
  commissionRatePercent: 1,
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};

interface Options {
  readonly builderId?: string | null;
  readonly saveFails?: boolean;
  readonly save?: Subject<Builder>;
}

async function setup(options: Options = {}) {
  const api = {
    listBuilders: vi.fn(() => of({ builders: [BUILDER] })),
    createBuilder: vi.fn((body: BuilderCreateBody) =>
      options.saveFails
        ? throwError(() => ({ message: 'That sign-in key is taken.' }))
        : of({ ...BUILDER, id: 'b2', ...body } as Builder),
    ),
    updateBuilder: vi.fn((_id: string, body: BuilderUpdateBody) =>
      options.save
        ? options.save.asObservable()
        : options.saveFails
          ? throwError(() => ({ message: 'Could not save the builder.' }))
          : of({ ...BUILDER, ...body } as Builder),
    ),
  };
  const ref = {
    titleId: 'drawer-title',
    urlId: null,
    setDirty: vi.fn(),
    close: vi.fn(),
    requestClose: vi.fn(() => of(true)),
  };
  const toasts = { show: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideStore([AdminBuildersState]),
      { provide: AdminBuildersApiService, useValue: api },
      { provide: UiDrawerRef, useValue: ref },
      { provide: UiToastService, useValue: toasts },
      { provide: DIALOG_DATA, useValue: { builderId: options.builderId === undefined ? 'b1' : options.builderId } },
    ],
  });
  const store = TestBed.inject(Store);
  store.dispatch(new LoadBuilders());
  const fixture = TestBed.createComponent(AdminBuilderDrawerComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { api, ref, toasts, store, fixture, el };
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

function control(el: HTMLElement, name: string): HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement {
  const host = el.querySelector(`[formControlName="${name}"]`) as HTMLElement;
  const inner = host.matches('input, select, textarea') ? host : host.querySelector('input, select, textarea');
  return inner as HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement;
}

function type(el: HTMLElement, name: string, value: string): void {
  const input = control(el, name);
  input.value = value;
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input'));
  input.dispatchEvent(new Event('blur'));
  TestBed.tick();
}

function submit(el: HTMLElement): void {
  el.querySelector('form')!.dispatchEvent(new Event('submit'));
  TestBed.tick();
}

const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';

describe('AdminBuilderDrawerComponent (#541)', () => {
  it('renders the builder heading, status chip, slug and the five sections', async () => {
    const { el } = await setup();
    expect(el.querySelector('.ui-drawer__title')?.textContent?.trim()).toBe('Elite Craft Builders');
    expect(el.querySelector('.ui-drawer__sub ui-status-chip')?.textContent?.trim()).toBe('Active');
    expect(el.querySelector('.builder-drawer__slug')?.textContent).toBe('elite-craft');
    const headings = Array.from(el.querySelectorAll('.builder-drawer__heading')).map((h) =>
      h.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(headings).toEqual(['Identity', 'Contact', 'Branding', 'Commercial', 'Embed origins (2)']);
  });

  it('prefills the form and locks the sign-in key on edit', async () => {
    const { el } = await setup();
    expect(control(el, 'businessName').value).toBe('Elite Craft Builders');
    expect(control(el, 'tenantKey').value).toBe('elite-craft');
    expect(control(el, 'tenantKey').disabled).toBe(true);
    expect(control(el, 'commissionRate').value).toBe('1');
    expect(control(el, 'defaultPaymentMethod').value).toBe('e_transfer');
    expect(control(el, 'allowedOrigins').value).toBe('elite.example\nwww.elite.example');
    expect(text(el)).toContain('Locked');
    // Brand colour swatch previews the saved hex.
    const swatch = el.querySelector('[data-testid="accent-swatch"]') as HTMLElement;
    expect(swatch.classList).not.toContain('builder-drawer__swatch--empty');
  });

  it('AC1: a rate edit shows the before → after rate and the future-invoices note', async () => {
    const { el } = await setup();
    expect(el.querySelector('[data-testid="rate-change"]')).toBeNull();

    type(el, 'commissionRate', '1.5');
    const change = el.querySelector('[data-testid="rate-change"]') as HTMLElement;
    expect(change).not.toBeNull();
    expect(change.querySelector('.builder-drawer__rate-before')?.textContent).toBe('1%');
    expect(change.querySelector('strong')?.textContent).toBe('1.5%');
    expect(text(change)).toContain('Applies to invoices created from now on');

    // Back to the saved rate, or an out-of-range value: no before/after.
    type(el, 'commissionRate', '1');
    expect(el.querySelector('[data-testid="rate-change"]')).toBeNull();
    type(el, 'commissionRate', '12');
    expect(el.querySelector('[data-testid="rate-change"]')).toBeNull();
    expect(text(el)).toContain('Enter a rate between 0 and 10 percent.');
  });

  it('AC1: 0% is a real rate and shows as a change', async () => {
    const { el } = await setup();
    type(el, 'commissionRate', '0');
    expect(el.querySelector('[data-testid="rate-change"] strong')?.textContent).toBe('0%');
  });

  it('sends the new rate and the dedicated payment method on save, then closes with a toast', async () => {
    const { el, api, ref, toasts } = await setup();
    type(el, 'commissionRate', '1.25');
    type(el, 'defaultPaymentMethod', 'cheque');
    submit(el);
    await until(() => ref.close.mock.calls.length === 1, 'drawer closes');
    const [id, body] = api.updateBuilder.mock.calls[0];
    expect(id).toBe('b1');
    expect(body).toMatchObject({
      commissionRatePercent: 1.25,
      defaultPaymentMethod: 'cheque',
      allowedOrigins: ['elite.example', 'www.elite.example'],
      plan: 'flat',
      settings: { defaultPaymentMethod: 'e_transfer', theme: 'dark' },
    });
    expect(body).not.toHaveProperty('tenantKey');
    expect(toasts.show).toHaveBeenCalledWith({ message: 'Builder saved.' });
  });

  it('omits the rate when the field is cleared on edit (no change)', async () => {
    const { el, api, ref } = await setup();
    type(el, 'commissionRate', '');
    submit(el);
    await until(() => ref.close.mock.calls.length === 1, 'drawer closes');
    expect(api.updateBuilder.mock.calls[0][1]).not.toHaveProperty('commissionRatePercent');
  });

  it('AC2: settings JSON sits behind a closed "Advanced" disclosure', async () => {
    const { el } = await setup();
    const advanced = el.querySelector('[data-testid="advanced"]') as HTMLDetailsElement;
    expect(advanced.tagName).toBe('DETAILS');
    expect(advanced.open).toBe(false);
    expect(advanced.querySelector('summary')?.textContent?.trim()).toBe('Advanced');
    expect(JSON.parse(control(el, 'settings').value)).toEqual({ defaultPaymentMethod: 'e_transfer', theme: 'dark' });
  });

  it('AC2: invalid JSON blocks the save, opens Advanced and explains the problem', async () => {
    const { el, api } = await setup();
    type(el, 'settings', '{ not json');
    submit(el);
    const advanced = el.querySelector('[data-testid="advanced"]') as HTMLDetailsElement;
    expect(advanced.open).toBe(true);
    expect(text(el)).toContain('Settings must be valid JSON (or leave blank).');
    expect(control(el, 'settings').getAttribute('aria-invalid')).toBe('true');
    expect(api.updateBuilder).not.toHaveBeenCalled();

    type(el, 'settings', '[1, 2]');
    expect(text(el)).toContain('Settings must be a JSON object');
  });

  it('keeps the drawer open and shows the error when the save fails', async () => {
    const { el, ref } = await setup({ saveFails: true });
    type(el, 'displayName', 'Elite');
    submit(el);
    await until(() => !!el.querySelector('.builder-drawer__alert'), 'save error');
    expect(el.querySelector('.builder-drawer__alert')?.textContent).toContain('Could not save the builder.');
    expect(ref.close).not.toHaveBeenCalled();
  });

  it('arms the discard guard once the form is edited', async () => {
    const { el, ref } = await setup();
    expect(ref.setDirty).toHaveBeenLastCalledWith(false);
    type(el, 'phone', '403-555-0101');
    await until(() => ref.setDirty.mock.calls.at(-1)?.[0] === true, 'dirty');
  });

  describe('Add builder (no builderId)', () => {
    it('opens blank with an editable sign-in key and rejects a bad one', async () => {
      const { el } = await setup({ builderId: null });
      expect(el.querySelector('.ui-drawer__title')?.textContent?.trim()).toBe('Add builder');
      expect(control(el, 'tenantKey').disabled).toBe(false);
      type(el, 'tenantKey', 'Elite Craft!');
      expect(text(el)).toContain('Use lowercase letters, numbers, and dashes only');
      // No before/after on create.
      type(el, 'commissionRate', '2');
      expect(el.querySelector('[data-testid="rate-change"]')).toBeNull();
    });

    it('creates with the rate and merges the payment method into settings', async () => {
      const { el, api, ref, toasts } = await setup({ builderId: null });
      type(el, 'businessName', 'North Homes Ltd');
      type(el, 'displayName', 'North Homes');
      type(el, 'tenantKey', 'north-homes');
      type(el, 'plan', 'commission');
      type(el, 'commissionRate', '1.5');
      type(el, 'defaultPaymentMethod', 'bank_draft');
      type(el, 'allowedOrigins', ' north.example \n\n');
      submit(el);
      await until(() => ref.close.mock.calls.length === 1, 'drawer closes');
      expect(api.createBuilder.mock.calls[0][0]).toEqual({
        tenantKey: 'north-homes',
        businessName: 'North Homes Ltd',
        displayName: 'North Homes',
        email: null,
        phone: null,
        logoUrl: null,
        accentColor: null,
        allowedOrigins: ['north.example'],
        plan: 'commission',
        status: 'active',
        commissionRatePercent: 1.5,
        settings: { defaultPaymentMethod: 'bank_draft' },
      });
      expect(toasts.show).toHaveBeenCalledWith({ message: 'Builder added.' });
    });

    it('blocks the save until the required fields are filled', async () => {
      const { el, api } = await setup({ builderId: null });
      submit(el);
      expect(text(el)).toContain('This field is required.');
      expect(api.createBuilder).not.toHaveBeenCalled();
    });
  });
});
