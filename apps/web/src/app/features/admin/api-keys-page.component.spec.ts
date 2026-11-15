/**
 * Admin API keys page (#546, review S13): the kit DataTable (Name · Builder
 * · Prefix · Scopes chips · Last used · Status), drawer + issue modal
 * wiring, viewer gating, and the one-time secret modal — which a scrim
 * click or Esc can't dismiss (AC1) — opened from a fresh plaintext and
 * cleared when the page is left.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Store, provideStore } from '@ngxs/store';
import { Subject, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyRecordResponse, Builder } from '@feasly/contracts';
import { UiDrawerService, UiModalService } from '@app/shared/ui';
import { API_SERVICE } from '../../core/api/api.service';
import { AdminAuthState } from './admin-auth.state';
import { AdminBuildersApiService } from './admin-builders-api.service';
import { AdminBuildersState } from './admin-builders.state';
import { ADMIN_PERMISSIONS } from './admin-permissions';
import { ApiKeyDrawerComponent } from './api-key-drawer.component';
import { ApiKeyIssueModalComponent } from './api-key-issue-modal.component';
import { ApiKeySecretModalComponent } from './api-key-secret-modal.component';
import { IssueApiKey } from './api-keys.actions';
import { ApiKeysState } from './api-keys.state';
import { ApiKeysPageComponent } from './api-keys-page.component';

const KEY: ApiKeyRecordResponse = {
  id: 'key-1',
  name: 'Elite production',
  tenant_id: 'elite-craft',
  key_prefix: 'feasly_live_…abcd',
  scopes: ['estimate', 'lead'],
  rate_limit_per_min: 60,
  sandbox: false,
  revoked_at: null,
  last_used_at: null,
  created_at: '2026-09-25T00:00:00.000Z',
};

const SANDBOX_KEY: ApiKeyRecordResponse = {
  ...KEY,
  id: 'key-2',
  name: 'Partner test',
  tenant_id: null,
  key_prefix: 'feasly_test_…wxyz',
  scopes: ['property:read'],
  sandbox: true,
  revoked_at: '2026-10-01T00:00:00.000Z',
};

const BUILDER = {
  id: 'b1',
  tenantKey: 'elite-craft',
  businessName: 'Elite Craft Builders',
  displayName: 'Elite Craft',
} as Builder;

interface Options {
  readonly canManage?: boolean;
  readonly url?: string;
  /** Use the real CDK-backed modal service instead of a spy. */
  readonly realModals?: boolean;
}

async function setup(options: Options = {}) {
  const api = {
    listApiKeys: vi.fn(() => of({ keys: [KEY, SANDBOX_KEY] })),
    issueApiKey: vi.fn(() => of({ key: { ...KEY, id: 'key-3', name: 'New key' }, plaintext: 'feasly_live_secret_once' })),
    rotateApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
    updateApiKey: vi.fn(),
    getApiKeyUsage: vi.fn(() => of([])),
  };
  const drawerOpen = vi.fn();
  const modalOpen = vi.fn(() => ({ closed: new Subject<unknown>(), close: vi.fn() }));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ApiKeysPageComponent],
    providers: [
      provideHttpClient(),
      provideRouter([{ path: '**', component: ApiKeysPageComponent }]),
      provideLocationMocks(),
      provideStore([ApiKeysState, AdminBuildersState, AdminAuthState]),
      { provide: API_SERVICE, useValue: api },
      { provide: AdminBuildersApiService, useValue: { listBuilders: vi.fn(() => of({ builders: [BUILDER] })) } },
      { provide: UiDrawerService, useValue: { open: drawerOpen, openDrawer: null } },
      ...(options.realModals ? [] : [{ provide: UiModalService, useValue: { open: modalOpen } }]),
    ],
  });
  const store = TestBed.inject(Store);
  store.reset({
    ...store.snapshot(),
    adminAuth: {
      ...store.selectSnapshot((s) => s.adminAuth),
      permissions: options.canManage === false ? [] : [ADMIN_PERMISSIONS.apiKeysManage],
    },
  });
  await TestBed.inject(Router).navigateByUrl(options.url ?? '/admin/api-keys');
  const fixture = TestBed.createComponent(ApiKeysPageComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { api, drawerOpen, modalOpen, store, fixture, el };
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
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const secretModal = () => document.querySelector('[data-testid="secret-modal"]');

describe('ApiKeysPageComponent (#546)', () => {
  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach((n) => (n.innerHTML = ''));
  });

  it('renders Name · Builder · Prefix · Scopes · Last used · Status', async () => {
    const { el } = await setup();
    const headers = Array.from(el.querySelectorAll('.ui-dt__table thead th')).map(text);
    expect(headers.slice(0, 6)).toEqual(['Name', 'Builder', 'Prefix', 'Scopes', 'Last used', 'Status']);

    const [live, sandbox] = rows(el);
    expect(text(live.querySelector('.keys-page__name'))).toBe('Elite production');
    // tenant_id resolves to the builder's display name.
    expect(text(live.querySelector('.keys-page__builder'))).toBe('Elite Craft');
    expect(text(live.querySelector('.keys-page__prefix'))).toBe('feasly_live_…abcd');
    expect(Array.from(live.querySelectorAll('.keys-page__chip')).map(text)).toEqual(['estimate', 'lead']);
    expect(text(live)).toContain('Never');
    expect(text(live)).toContain('Active');

    expect(text(sandbox.querySelector('.keys-page__sandbox'))).toBe('Sandbox');
    expect(text(sandbox)).toContain('No builder');
    expect(text(sandbox)).toContain('Revoked');
  });

  it('opens the key drawer from a row with ?open=<id>', async () => {
    const { el, drawerOpen } = await setup();
    rows(el)[0].click();
    expect(drawerOpen).toHaveBeenCalledWith(
      ApiKeyDrawerComponent,
      expect.objectContaining({ urlId: 'key-1', data: { keyId: 'key-1', canManage: true } }),
    );
  });

  it('opens the drawer from a deep link once the list has loaded', async () => {
    const { drawerOpen } = await setup({ url: '/admin/api-keys?open=key-2' });
    await until(() => drawerOpen.mock.calls.length > 0, 'deep-link drawer');
    expect(drawerOpen.mock.calls[0][1].urlId).toBe('key-2');
  });

  it('"Issue key" opens the issue modal', async () => {
    const { el, modalOpen } = await setup();
    (el.querySelector('[data-testid="issue-key"]') as HTMLButtonElement).click();
    expect(modalOpen).toHaveBeenCalledWith(ApiKeyIssueModalComponent, expect.anything());
  });

  it('hides "Issue key" from viewers and opens their drawer read-only', async () => {
    const { el, drawerOpen } = await setup({ canManage: false });
    expect(el.querySelector('[data-testid="issue-key"]')).toBeNull();
    rows(el)[0].click();
    expect(drawerOpen.mock.calls[0][1].data.canManage).toBe(false);
  });

  it('opens the secret modal with scrim and Esc dismissal switched off', async () => {
    const { store, modalOpen } = await setup();
    await new Promise<void>((resolve) => store.dispatch(new IssueApiKey({ name: 'New key' })).subscribe(() => resolve()));
    await until(() => modalOpen.mock.calls.length > 0, 'secret modal open');
    expect(modalOpen).toHaveBeenCalledWith(
      ApiKeySecretModalComponent,
      expect.objectContaining({ dismissOnScrim: false, dismissOnEsc: false }),
    );
  });

  it('AC1: a scrim click or Esc does not dismiss the one-time secret modal', async () => {
    const { store } = await setup({ realModals: true });
    await new Promise<void>((resolve) => store.dispatch(new IssueApiKey({ name: 'New key' })).subscribe(() => resolve()));
    await until(() => secretModal() !== null, 'secret modal rendered');
    expect((document.querySelector('[data-testid="secret-value"]') as HTMLInputElement).value).toBe('feasly_live_secret_once');
    // No × button.
    expect(document.querySelector('.ui-modal__close')).toBeNull();

    const scrim = document.querySelector('.ui-modal-scrim') as HTMLElement;
    expect(scrim).toBeTruthy();
    scrim.click();
    document
      .querySelector('.ui-modal-pane')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    TestBed.tick();
    expect(secretModal()).not.toBeNull();
    expect(store.selectSnapshot(ApiKeysState.plaintext)).toBe('feasly_live_secret_once');

    // Only the acknowledged Done closes it, and clears the plaintext.
    const done = document.querySelector('[data-testid="secret-done"]') as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    (document.querySelector('[data-testid="secret-ack"]') as HTMLInputElement).click();
    TestBed.tick();
    expect(done.disabled).toBe(false);
    done.click();
    await until(() => secretModal() === null, 'secret modal closed');
    expect(store.selectSnapshot(ApiKeysState.plaintext)).toBeNull();
  });

  it('clears the plaintext when the page is left', async () => {
    const { store, fixture } = await setup();
    await new Promise<void>((resolve) => store.dispatch(new IssueApiKey({ name: 'New key' })).subscribe(() => resolve()));
    expect(store.selectSnapshot(ApiKeysState.plaintext)).toBe('feasly_live_secret_once');
    fixture.destroy();
    expect(store.selectSnapshot(ApiKeysState.plaintext)).toBeNull();
  });

  it('shows the error state with a retry', async () => {
    const { el, api, store } = await setup();
    api.listApiKeys.mockReturnValueOnce(of({ keys: [] }));
    store.reset({ ...store.snapshot(), apiKeys: { ...store.selectSnapshot((s) => s.apiKeys), loadFailed: true } });
    TestBed.tick();
    expect(text(el)).toContain('Couldn’t load API keys');
  });
});
