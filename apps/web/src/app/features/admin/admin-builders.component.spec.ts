import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import { AdminBuildersComponent } from './admin-builders.component';
import { AdminBuildersState } from './admin-builders.state';
import { LoadBuilders } from './admin-builders.actions';
import type { Builder } from '@feasly/contracts';

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
  tenantKey: 'north-homes',
  businessName: 'North Homes Ltd',
  displayName: 'North Homes',
  email: null,
  plan: null,
  status: 'inactive',
};

/**
 * Poll an async UI condition until it holds (or the deadline passes).
 * Never asserts on UI state after a fixed sleep — the component's
 * dispatch → HTTP → NGXS → signal chain settles on its own schedule.
 */
async function waitFor(
  fixture: ComponentFixture<AdminBuildersComponent>,
  condition: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    fixture.detectChanges();
    if (condition()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Admin builders page (embed/02 admin-UI migration): builders table,
 * create/edit form with validation, save + error states.
 */
describe('AdminBuildersComponent', () => {
  let store: Store;
  let httpMock: HttpTestingController;
  let fixture: ComponentFixture<AdminBuildersComponent>;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AdminBuildersComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ConfigService,
        provideStore([AdminBuildersState]),
      ],
    });
    const config = TestBed.inject(ConfigService);
    const http = TestBed.inject(HttpTestingController);
    const pending = config.load();
    http.expectOne('/assets/config/app-config.json').flush({ api: { useMockApi: false } });
    await pending;
    store = TestBed.inject(Store);
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AdminBuildersComponent);
  }

  /** Mounts the page; flushes the LoadBuilders GET the component dispatches on init. */
  async function loadPage(builders: Builder[] = [BUILDER_A, BUILDER_B]): Promise<void> {
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/builders') && r.method === 'GET')
      .flush({ builders });
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function rows(): HTMLElement[] {
    return Array.from(
      fixture.debugElement.queryAll(By.css('.builders-page__table tbody tr')),
    ).map((row) => row.nativeElement as HTMLElement);
  }

  function setField(name: string, value: string): void {
    const input = fixture.debugElement.query(
      By.css(`[formControlName="${name}"]`),
    ).nativeElement as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  function fieldErrors(): string[] {
    return fixture.debugElement
      .queryAll(By.css('.builders-page__field-error'))
      .map((el) => (el.nativeElement as HTMLElement).textContent ?? '');
  }

  function clickSubmit(): void {
    const form = fixture.debugElement.query(By.css('.builders-page__form-card form'));
    form.nativeElement.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
  }

  it('renders the builders table with status, plan, and sign-in key', async () => {
    await setup();
    await loadPage();

    const tableRows = rows();
    expect(tableRows).toHaveLength(2);
    expect(tableRows[0].textContent).toContain('Elite Craft Builders');
    expect(tableRows[0].textContent).toContain('elite-craft');
    expect(tableRows[0].textContent).toContain('Active');
    expect(tableRows[0].textContent).toContain('Flat');
    expect(tableRows[0].textContent).toContain('hello@elite.example');
    expect(tableRows[1].textContent).toContain('North Homes Ltd');
    expect(tableRows[1].textContent).toContain('Inactive');
    expect(tableRows[1].textContent).toContain('Undecided');
  });

  it('shows an empty state with a call to action when there are no builders', async () => {
    await setup();
    await loadPage([]);

    const empty = fixture.debugElement.query(By.css('.builders-page__empty'));
    expect(empty).toBeTruthy();
    expect(empty.nativeElement.textContent).toContain('No builders yet');
  });

  it('rejects an invalid sign-in key with buyer-grade guidance', async () => {
    await setup();
    await loadPage();

    fixture.debugElement.query(By.css('.builders-page__add')).nativeElement.click();
    fixture.detectChanges();

    setField('tenantKey', 'Elite Craft!');
    // Blur marks the control touched so the error renders.
    const input = fixture.debugElement.query(By.css('[formControlName="tenantKey"]'));
    input.nativeElement.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(fieldErrors().join(' ')).toContain('lowercase letters, numbers, and dashes');
  });

  it('creates a builder and shows the success banner', async () => {
    await setup();
    await loadPage([BUILDER_A]);

    fixture.debugElement.query(By.css('.builders-page__add')).nativeElement.click();
    fixture.detectChanges();

    setField('businessName', 'North Homes Ltd');
    setField('displayName', 'North Homes');
    setField('tenantKey', 'north-homes');
    setField('email', 'hello@north.example');
    setField('plan', 'commission');

    clickSubmit();

    const req = httpMock.expectOne(
      (r) => r.url.endsWith('/api/v1/admin/builders') && r.method === 'POST',
    );
    expect(req.request.body).toMatchObject({
      tenantKey: 'north-homes',
      businessName: 'North Homes Ltd',
      displayName: 'North Homes',
      email: 'hello@north.example',
      plan: 'commission',
    });
    req.flush(BUILDER_B);

    // The saved banner appears once NGXS processes the create response.
    await waitFor(fixture, () => store.selectSnapshot(AdminBuildersState.saved), 'saved banner');
    const banner = fixture.debugElement.query(
      By.css('.builders-page__banner--success'),
    );
    expect(banner.nativeElement.textContent).toContain('Builder added.');
    // The new row is in the table.
    expect(rows()).toHaveLength(2);
    expect(rows()[1].textContent).toContain('North Homes Ltd');
  });

  it('edits a builder with the sign-in key locked', async () => {
    await setup();
    await loadPage();

    const editButtons = fixture.debugElement.queryAll(By.css('.builders-page__edit'));
    editButtons[0].nativeElement.click();
    fixture.detectChanges();

    // Form prefilled; the sign-in key is disabled (immutable after creation).
    const tenantKey = fixture.debugElement.query(
      By.css('[formControlName="tenantKey"]'),
    ).nativeElement as HTMLInputElement;
    expect(tenantKey.value).toBe('elite-craft');
    expect(tenantKey.disabled).toBe(true);

    setField('displayName', 'Elite Craft Homes');
    clickSubmit();

    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/builders/b1'));
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toMatchObject({ displayName: 'Elite Craft Homes' });
    // tenantKey is never sent on update.
    expect(req.request.body).not.toHaveProperty('tenantKey');
    req.flush({ ...BUILDER_A, displayName: 'Elite Craft Homes' });

    await waitFor(fixture, () => store.selectSnapshot(AdminBuildersState.saved), 'saved banner');
    const banner = fixture.debugElement.query(
      By.css('.builders-page__banner--success'),
    );
    expect(banner.nativeElement.textContent).toContain('Builder saved.');
    expect(rows()[0].textContent).toContain('Elite Craft Homes');
  });

  it('shows an inline error when the save fails', async () => {
    await setup();
    await loadPage([BUILDER_A]);

    fixture.debugElement.query(By.css('.builders-page__add')).nativeElement.click();
    fixture.detectChanges();

    setField('businessName', 'Duplicate');
    setField('displayName', 'Duplicate');
    setField('tenantKey', 'elite-craft');
    clickSubmit();

    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/builders') && r.method === 'POST')
      .error(new ProgressEvent('error'));

    await waitFor(
      fixture,
      () => store.selectSnapshot(AdminBuildersState.saveError) !== null,
      'save error',
    );
    const banner = fixture.debugElement.query(
      By.css('.builders-page__banner--error'),
    );
    expect(banner).toBeTruthy();
    expect(banner.nativeElement.getAttribute('role')).toBe('alert');
  });

  it('rejects invalid JSON in the advanced settings field', async () => {
    await setup();
    await loadPage();

    fixture.debugElement.query(By.css('.builders-page__add')).nativeElement.click();
    fixture.detectChanges();

    setField('settings', '{ not json');
    const textarea = fixture.debugElement.query(By.css('[formControlName="settings"]'));
    textarea.nativeElement.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(fieldErrors().join(' ')).toContain('valid JSON');
  });

  it('reloads the table when the list request fails and retry is clicked', async () => {
    await setup();
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/builders') && r.method === 'GET')
      .error(new ProgressEvent('error'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(store.selectSnapshot(AdminBuildersState.listStatus)).toBe('error');

    fixture.debugElement.query(By.css('.builders-page__state--error button')).nativeElement.click();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/admin/builders') && r.method === 'GET')
      .flush({ builders: [BUILDER_A] });

    await waitFor(fixture, () => rows().length === 1, 'table reload');
    expect(rows()[0].textContent).toContain('Elite Craft Builders');
  });

  it('shows the per-builder commission rate in the table', async () => {
    await setup();
    await loadPage([BUILDER_A]);

    expect(rows()[0].textContent).toContain('1%');
  });

  it('pre-fills the rate on edit and omits it from the payload when cleared', async () => {
    await setup();
    await loadPage();

    const editButtons = fixture.debugElement.queryAll(By.css('.builders-page__edit'));
    editButtons[0].nativeElement.click();
    fixture.detectChanges();

    const rateInput = fixture.debugElement.query(
      By.css('[formControlName="commissionRatePercent"]'),
    ).nativeElement as HTMLInputElement;
    expect(rateInput.value).toBe('1');

    // Clear the field = no change: the PATCH must not carry the key.
    setField('commissionRatePercent', '');
    clickSubmit();

    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/builders/b1'));
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).not.toHaveProperty('commissionRatePercent');
    req.flush(BUILDER_A);
  });

  it('sends the new rate when it changes on edit', async () => {
    await setup();
    await loadPage();

    const editButtons = fixture.debugElement.queryAll(By.css('.builders-page__edit'));
    editButtons[0].nativeElement.click();
    fixture.detectChanges();

    setField('commissionRatePercent', '2');
    clickSubmit();

    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/builders/b1'));
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toMatchObject({ commissionRatePercent: 2 });
    req.flush({ ...BUILDER_A, commissionRatePercent: 2 });

    await waitFor(fixture, () => store.selectSnapshot(AdminBuildersState.saved), 'saved banner');
    expect(rows()[0].textContent).toContain('2%');
  });

  it('blocks saving a rate outside 0–10% with buyer-grade guidance', async () => {
    await setup();
    await loadPage();

    const editButtons = fixture.debugElement.queryAll(By.css('.builders-page__edit'));
    editButtons[0].nativeElement.click();
    fixture.detectChanges();

    setField('commissionRatePercent', '11');
    const rateInput = fixture.debugElement.query(
      By.css('[formControlName="commissionRatePercent"]'),
    );
    rateInput.nativeElement.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(fieldErrors().join(' ')).toContain('between 0 and 10');

    clickSubmit();
    httpMock.expectNone((r) => r.url.endsWith('/api/v1/admin/builders/b1'));
  });

  it('includes the rate when creating a builder', async () => {
    await setup();
    await loadPage([BUILDER_A]);

    fixture.debugElement.query(By.css('.builders-page__add')).nativeElement.click();
    fixture.detectChanges();

    setField('businessName', 'North Homes Ltd');
    setField('displayName', 'North Homes');
    setField('tenantKey', 'north-homes');
    setField('commissionRatePercent', '1.5');
    clickSubmit();

    const req = httpMock.expectOne(
      (r) => r.url.endsWith('/api/v1/admin/builders') && r.method === 'POST',
    );
    expect(req.request.body).toMatchObject({ commissionRatePercent: 1.5 });
    req.flush({ ...BUILDER_B, commissionRatePercent: 1.5 });

    await waitFor(fixture, () => store.selectSnapshot(AdminBuildersState.saved), 'saved banner');
    expect(rows()[1].textContent).toContain('1.5%');
  });

  it('shows the default payment method in the table', async () => {
    await setup();
    await loadPage([BUILDER_A]);

    expect(rows()[0].textContent).toContain('Card on file (auto-charge)');
  });

  it('pre-fills the default payment method on edit and sends the dedicated field', async () => {
    await setup();
    await loadPage();

    const editButtons = fixture.debugElement.queryAll(By.css('.builders-page__edit'));
    editButtons[0].nativeElement.click();
    fixture.detectChanges();

    const methodSelect = fixture.debugElement.query(
      By.css('[formControlName="defaultPaymentMethod"]'),
    ).nativeElement as HTMLSelectElement;
    expect(methodSelect.value).toBe('card');

    setField('defaultPaymentMethod', 'e_transfer');
    clickSubmit();

    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/builders/b1'));
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toMatchObject({ defaultPaymentMethod: 'e_transfer' });
    req.flush({
      ...BUILDER_A,
      settings: { defaultPaymentMethod: 'e_transfer' },
    });

    await waitFor(fixture, () => store.selectSnapshot(AdminBuildersState.saved), 'saved banner');
    expect(rows()[0].textContent).toContain('E-transfer');
  });

  it('merges the default payment method into the settings JSON on create', async () => {
    await setup();
    await loadPage([BUILDER_A]);

    fixture.debugElement.query(By.css('.builders-page__add')).nativeElement.click();
    fixture.detectChanges();

    setField('businessName', 'North Homes Ltd');
    setField('displayName', 'North Homes');
    setField('tenantKey', 'north-homes');
    setField('defaultPaymentMethod', 'cheque');
    clickSubmit();

    const req = httpMock.expectOne(
      (r) => r.url.endsWith('/api/v1/admin/builders') && r.method === 'POST',
    );
    expect(req.request.body.settings).toMatchObject({
      defaultPaymentMethod: 'cheque',
    });
    expect(req.request.body).not.toHaveProperty('defaultPaymentMethod');
    req.flush({ ...BUILDER_B });
  });
});
