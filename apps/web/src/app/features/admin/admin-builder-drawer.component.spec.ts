/**
 * Admin builder drawer (#541, review S7): sections, locked sign-in key,
 * commission-rate before → after (AC1), the settings JSON behind an
 * "Advanced" disclosure with validation (AC2), create/update payloads,
 * and the save-error path.
 */
import { DIALOG_DATA } from '@angular/cdk/dialog';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Store, provideStore } from '@ngxs/store';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type {
  ApiError,
  Builder,
  BuilderCreateBody,
  BuilderLifecycleBody,
  BuilderOffboardingBlocker,
  BuilderUpdateBody,
} from '@feasly/contracts';
import { stubObjectUrls } from '../../shared/test-helpers/object-url.stub';
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
  /** The row the list returns (default BUILDER). */
  readonly builder?: Builder;
  readonly blockers?: readonly BuilderOffboardingBlocker[];
  /** Lifecycle POST fails with this error. */
  readonly statusError?: ApiError;
  readonly saveFails?: boolean;
  readonly save?: Subject<Builder>;
}

async function setup(options: Options = {}) {
  const row = options.builder ?? BUILDER;
  const api = {
    listBuilders: vi.fn(() => of({ builders: [row] })),
    changeStatus: vi.fn((_id: string, body: BuilderLifecycleBody) =>
      options.statusError
        ? throwError(() => options.statusError)
        : of({
            builder: {
              ...row,
              status: body.action === 'suspend' ? ('suspended' as const) : ('active' as const),
              statusReason: body.reason,
              statusChangedAt: '2026-11-16T15:00:00.000Z',
              statusChangedBy: 'ops@feasly.example',
            },
            changed: true,
          }),
    ),
    offboardingBlockers: vi.fn(() => of({ blockers: options.blockers ?? [] })),
    exportCsv: vi.fn(() => of(new Blob(['lead_id\n']))),
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
      provideRouter([{ path: '**', children: [] }]),
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
    expect(headings).toEqual([
      'Identity',
      'Account status',
      'Contact',
      'Branding',
      'Commercial',
      'Embed origins (2)',
      'Export builder data',
    ]);
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

/** #861: account status, lifecycle confirm flows, offboarding checklist, export. */
describe('AdminBuilderDrawerComponent lifecycle (#861)', () => {
  const dialog = (): HTMLElement | null => document.querySelector('app-admin-builder-lifecycle-modal');
  const button = (root: ParentNode, testId: string) =>
    root.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;

  async function openAndType(el: HTMLElement, action: string, reason: string): Promise<HTMLElement> {
    button(el, `lifecycle-${action}`)!.click();
    await until(() => dialog()?.querySelector('textarea') != null, 'lifecycle modal open');
    const modal = dialog()!;
    const textarea = modal.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = reason;
    textarea.dispatchEvent(new Event('input'));
    TestBed.tick();
    return modal;
  }

  function submitModal(modal: HTMLElement): void {
    modal.querySelector('form')!.dispatchEvent(new Event('submit'));
    TestBed.tick();
  }

  it('offers Suspend and Start offboarding for an active builder (no status select)', async () => {
    const { el } = await setup();
    expect(el.querySelector('[formControlName="status"]')).toBeNull();
    const labels = Array.from(el.querySelectorAll('[data-testid^="lifecycle-"]')).map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Suspend', 'Start offboarding']);
  });

  it('suspend needs a reason, then posts it and updates the status in place', async () => {
    const { el, api, toasts } = await setup();
    const modal = await openAndType(el, 'suspend', ' ');
    expect(text(modal)).toContain('Suspend Elite Craft Builders?');
    expect(text(modal)).toContain('gets no new leads');
    submitModal(modal);
    expect(text(modal)).toContain('Enter a reason of at least 3 characters.');
    expect(api.changeStatus).not.toHaveBeenCalled();

    const textarea = modal.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '  Three unpaid invoices  ';
    textarea.dispatchEvent(new Event('input'));
    TestBed.tick();
    submitModal(modal);
    await until(() => dialog() === null, 'modal closes');
    expect(api.changeStatus).toHaveBeenCalledWith('b1', { action: 'suspend', reason: 'Three unpaid invoices' });
    expect(toasts.show).toHaveBeenCalledWith({ message: 'Builder suspended.' });
    await until(() => text(el).includes('Reactivate'), 'buttons follow the new status');
    expect(el.querySelector('.ui-drawer__sub ui-status-chip')?.textContent?.trim()).toBe('Suspended');
    expect(el.querySelector('[data-testid="status-reason"]')?.textContent).toContain('Three unpaid invoices');
    expect(text(el)).toContain('by ops@feasly.example');
  });

  it('cancel closes the confirm without a request', async () => {
    const { el, api } = await setup();
    const modal = await openAndType(el, 'start_offboarding', 'Moving on');
    (Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Cancel') as HTMLButtonElement).click();
    await until(() => dialog() === null, 'modal closes');
    expect(api.changeStatus).not.toHaveBeenCalled();
  });

  it('offboarding: checklist lists blockers with links to the invoice', async () => {
    const { el, api } = await setup({
      builder: { ...BUILDER, status: 'offboarding' },
      blockers: [
        { kind: 'unpaid_invoice', invoiceId: 'inv-1', invoiceNumber: 'FEA-0001', status: 'awaiting_payment' },
        { kind: 'open_dispute', invoiceId: 'inv-2', invoiceNumber: null, status: 'open' },
      ],
    });
    await until(() => el.querySelectorAll('[data-testid="checklist-blocker"]').length === 2, 'blockers render');
    expect(api.offboardingBlockers).toHaveBeenCalledWith('b1');
    const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('[data-testid="checklist-blocker"]'));
    expect(links[0].textContent).toContain('FEA-0001 — unpaid (awaiting payment)');
    expect(links[0].getAttribute('href')).toBe('/admin/billing/invoices?open=inv-1');
    expect(links[1].textContent).toContain('Invoice — open dispute (open)');
    const labels = Array.from(el.querySelectorAll('[data-testid^="lifecycle-"]')).map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Complete offboarding', 'Reactivate']);
  });

  it('offboarding with nothing open shows a clear checklist', async () => {
    const { el } = await setup({ builder: { ...BUILDER, status: 'offboarding' } });
    await until(() => el.querySelector('[data-testid="checklist-clear"]') !== null, 'clear checklist');
    expect(text(el)).toContain('No unpaid invoices or open disputes.');
  });

  it('complete offboarding refused for blockers stays open with the reason and refreshes the checklist', async () => {
    const { el, api } = await setup({
      builder: { ...BUILDER, status: 'offboarding' },
      statusError: {
        code: 'OFFBOARDING_BLOCKED',
        message: "Offboarding can't be completed yet: FEA-0001 is unpaid.",
        retryable: false,
      },
    });
    await until(() => api.offboardingBlockers.mock.calls.length === 1, 'initial checklist load');
    const modal = await openAndType(el, 'complete_offboarding', 'Contract ended');
    submitModal(modal);
    await until(() => modal.querySelector('[data-testid="lifecycle-error"]') !== null, 'inline error');
    expect(text(modal)).toContain("Offboarding can't be completed yet");
    expect(dialog()).not.toBeNull();
    await until(() => api.offboardingBlockers.mock.calls.length === 2, 'checklist reloads');
    (Array.from(modal.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Cancel') as HTMLButtonElement).click();
    await until(() => dialog() === null, 'modal closes');
  });

  it('an offboarded builder has no lifecycle buttons', async () => {
    const { el } = await setup({ builder: { ...BUILDER, status: 'offboarded' } });
    expect(el.querySelectorAll('[data-testid^="lifecycle-"]').length).toBe(0);
    expect(text(el)).toContain('Offboarding is complete.');
  });

  it('Export leads downloads the CSV for this builder', async () => {
    const urls = stubObjectUrls();
    try {
      const { el, api } = await setup();
      button(el, 'export-leads')!.click();
      TestBed.tick();
      await until(() => urls.createObjectURL.mock.calls.length === 1, 'download starts');
      expect(api.exportCsv).toHaveBeenCalledWith('b1', 'leads');
    } finally {
      urls.restore();
    }
  });

  it('a failed export shows the server message', async () => {
    const { el, api } = await setup();
    api.exportCsv.mockReturnValueOnce(throwError(() => ({ message: 'Export failed (HTTP 500).' })));
    button(el, 'export-invoices')!.click();
    await until(() => text(el).includes('Export failed (HTTP 500).'), 'export error');
    expect(api.exportCsv).toHaveBeenCalledWith('b1', 'invoices');
  });
});
