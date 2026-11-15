/**
 * API key drawer (#546, review S13): Overview / Usage tabs, the scope +
 * rate-limit editor, rotate / revoke behind confirm dialogs, and the
 * read-only view for revoked keys and viewers.
 */
import { DIALOG_DATA } from '@angular/cdk/dialog';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Store, provideStore } from '@ngxs/store';
import { Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyRecordResponse } from '@feasly/contracts';
import { UiConfirmService, UiDrawerRef, UiToastService } from '@app/shared/ui';
import { API_SERVICE } from '../../core/api/api.service';
import { AdminBuildersApiService } from './admin-builders-api.service';
import { AdminBuildersState } from './admin-builders.state';
import { ApiKeyDrawerComponent } from './api-key-drawer.component';
import { LoadApiKeys } from './api-keys.actions';
import { ApiKeysState } from './api-keys.state';

const KEY: ApiKeyRecordResponse = {
  id: 'key-1',
  name: 'Elite production',
  tenant_id: 'elite-craft',
  key_prefix: 'feasly_live_…abcd',
  scopes: ['estimate'],
  rate_limit_per_min: 60,
  sandbox: false,
  revoked_at: null,
  last_used_at: null,
  created_at: '2026-09-25T00:00:00.000Z',
};

interface Options {
  readonly key?: ApiKeyRecordResponse;
  readonly canManage?: boolean;
  readonly confirm?: boolean;
}

async function setup(options: Options = {}) {
  const key = options.key ?? KEY;
  const api = {
    listApiKeys: vi.fn(() => of({ keys: [key] })),
    updateApiKey: vi.fn((_id: string, patch: Partial<ApiKeyRecordResponse>) => of({ ...key, ...patch })),
    rotateApiKey: vi.fn(() => of({ key: { ...key, id: 'key-2' }, plaintext: 'feasly_live_new' })),
    revokeApiKey: vi.fn(() => of(undefined)),
    getApiKeyUsage: vi.fn(() =>
      of([
        { date: '2026-11-13', endpoint: '/v1/estimate', count: 4, estimates_created: 2 },
        { date: '2026-11-14', endpoint: '/v1/estimate', count: 6, estimates_created: 3 },
        { date: '2026-11-14', endpoint: '/v1/property', count: 2, estimates_created: 0 },
      ]),
    ),
  };
  const closed = new Subject<void>();
  const ref = {
    titleId: 'drawer-title',
    urlId: 'key-1',
    closed: closed.asObservable(),
    setDirty: vi.fn(),
    close: vi.fn(() => closed.next()),
    requestClose: vi.fn(() => of(true)),
  };
  const confirms = { confirm: vi.fn(() => of(options.confirm ?? true)) };
  const toasts = { show: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideStore([ApiKeysState, AdminBuildersState]),
      { provide: API_SERVICE, useValue: api },
      { provide: AdminBuildersApiService, useValue: { listBuilders: vi.fn(() => of({ builders: [] })) } },
      { provide: UiDrawerRef, useValue: ref },
      { provide: UiConfirmService, useValue: confirms },
      { provide: UiToastService, useValue: toasts },
      { provide: DIALOG_DATA, useValue: { keyId: key.id, canManage: options.canManage ?? true } },
    ],
  });
  const store = TestBed.inject(Store);
  store.dispatch(new LoadApiKeys());
  const fixture = TestBed.createComponent(ApiKeyDrawerComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { api, ref, confirms, toasts, store, fixture, el };
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const text = (node: Element | null) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('ApiKeyDrawerComponent (#546)', () => {
  it('shows Overview first, with details and the builder fallback to its key', async () => {
    const { el, store } = await setup();
    expect(q(el, 'tab-overview')?.getAttribute('aria-selected')).toBe('true');
    expect(q(el, 'panel-overview')).not.toBeNull();
    const overview = text(q(el, 'panel-overview'));
    expect(overview).toContain('elite-craft'); // no builder loaded → raw tenant key
    expect(overview).toContain('feasly_live_…abcd');
    expect(overview).toContain('Never');
    expect(store.selectSnapshot(ApiKeysState.selected)?.id).toBe('key-1');
  });

  it('switches to Usage: per-day bars and the table collapsed', async () => {
    const { el, api } = await setup();
    q(el, 'tab-usage')!.click();
    TestBed.tick();
    await vi.waitFor(() => expect(q(el, 'usage-chart')).not.toBeNull());
    expect(api.getApiKeyUsage).toHaveBeenCalledWith('key-1');
    expect(q(el, 'panel-overview')).toBeNull();
    const bars = el.querySelectorAll('.usage__day');
    expect(bars.length).toBe(2);
    expect((bars[1].querySelector('.usage__bar') as HTMLElement).style.getPropertyValue('--share')).toBe('1');
    expect(text(el.querySelector('.usage__caption'))).toContain('12 requests over 2 days');
    expect((q(el, 'usage-details') as HTMLDetailsElement).open).toBe(false);
  });

  it('moves between tabs with the arrow keys', async () => {
    const { el } = await setup();
    el.querySelector('[role="tablist"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    TestBed.tick();
    expect(q(el, 'tab-usage')?.getAttribute('aria-selected')).toBe('true');
  });

  it('saves edited scopes and rate limit', async () => {
    const { el, api, toasts } = await setup();
    const lead = Array.from(el.querySelectorAll<HTMLInputElement>('.key-drawer__scopes input')).find(
      (i) => text(i.parentElement) === 'lead',
    )!;
    lead.click();
    const rate = el.querySelector('ui-text-field input') as HTMLInputElement;
    rate.value = '120';
    rate.dispatchEvent(new Event('input'));
    TestBed.tick();
    (q(el, 'save-key') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(api.updateApiKey).toHaveBeenCalled());
    expect(api.updateApiKey).toHaveBeenCalledWith('key-1', { scopes: ['estimate', 'lead'], rate_limit_per_min: 120 });
    expect(toasts.show).toHaveBeenCalledWith({ message: 'Key updated.' });
  });

  it('rotates after the confirm and closes (the page shows the new key)', async () => {
    const { el, api, ref, confirms, store } = await setup();
    q(el, 'rotate-key')!.click();
    expect(confirms.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Rotate Elite production?', tone: 'danger' }));
    await vi.waitFor(() => expect(ref.close).toHaveBeenCalled());
    expect(api.rotateApiKey).toHaveBeenCalledWith('key-1');
    expect(store.selectSnapshot(ApiKeysState.plaintext)).toBe('feasly_live_new');
  });

  it('does nothing when the revoke confirm is cancelled', async () => {
    const { el, api, ref } = await setup({ confirm: false });
    q(el, 'revoke-key')!.click();
    expect(api.revokeApiKey).not.toHaveBeenCalled();
    expect(ref.close).not.toHaveBeenCalled();
  });

  it('revokes after the confirm, toasts and closes', async () => {
    const { el, api, ref, toasts } = await setup();
    q(el, 'revoke-key')!.click();
    await vi.waitFor(() => expect(ref.close).toHaveBeenCalled());
    expect(api.revokeApiKey).toHaveBeenCalledWith('key-1');
    expect(toasts.show).toHaveBeenCalledWith({ message: 'Key revoked.' });
  });

  it('shows a revoked key read-only', async () => {
    const { el } = await setup({ key: { ...KEY, revoked_at: '2026-10-01T00:00:00.000Z' } });
    expect(text(el)).toContain('This key is revoked.');
    expect(q(el, 'rotate-key')).toBeNull();
    expect(q(el, 'save-key')).toBeNull();
    expect(el.querySelector('.key-drawer__chip')?.textContent).toBe('estimate');
  });

  it('gives viewers no write affordances', async () => {
    const { el } = await setup({ canManage: false });
    expect(el.querySelector('.key-drawer__scopes')).toBeNull();
    expect(q(el, 'revoke-key')).toBeNull();
    expect(q(el, 'save-key')).toBeNull();
  });
});
