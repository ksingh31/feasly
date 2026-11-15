/**
 * Issue-key modal (#546, review S13): the builder is picked from an
 * EntityCombobox over the builders list (AC2) and sent as the key's
 * tenant id; scopes / rate limit validate before anything is sent.
 */
import { DialogRef } from '@angular/cdk/dialog';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Store, provideStore } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyIssueRequest, ApiKeyRecordResponse, Builder } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { AdminBuildersApiService } from './admin-builders-api.service';
import { LoadBuilders } from './admin-builders.actions';
import { AdminBuildersState } from './admin-builders.state';
import { ApiKeyIssueModalComponent } from './api-key-issue-modal.component';
import { ApiKeysState } from './api-keys.state';

const BUILDERS = [
  { id: 'b1', tenantKey: 'elite-craft', businessName: 'Elite Craft Builders', displayName: 'Elite Craft' },
  { id: 'b2', tenantKey: 'bow-river', businessName: 'Bow River Custom Homes', displayName: 'Bow River' },
] as Builder[];

const ISSUED: ApiKeyRecordResponse = {
  id: 'key-9',
  name: 'Bow production',
  tenant_id: 'bow-river',
  key_prefix: 'feasly_live_…zzzz',
  scopes: ['estimate'],
  rate_limit_per_min: 60,
  sandbox: false,
  revoked_at: null,
  last_used_at: null,
  created_at: '2026-11-15T00:00:00.000Z',
};

async function setup(options: { fails?: boolean } = {}) {
  const api = {
    issueApiKey: vi.fn((_req: ApiKeyIssueRequest) =>
      options.fails ? throwError(() => new Error('boom')) : of({ key: ISSUED, plaintext: 'feasly_live_once' }),
    ),
  };
  const ref = { close: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideStore([ApiKeysState, AdminBuildersState]),
      { provide: API_SERVICE, useValue: api },
      { provide: AdminBuildersApiService, useValue: { listBuilders: vi.fn(() => of({ builders: BUILDERS })) } },
      { provide: DialogRef, useValue: ref },
    ],
  });
  TestBed.inject(Store).dispatch(new LoadBuilders());
  const fixture = TestBed.createComponent(ApiKeyIssueModalComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { api, ref, fixture, el, store: TestBed.inject(Store) };
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

const nameInput = (el: HTMLElement) => el.querySelector('ui-text-field input') as HTMLInputElement;
const combobox = (el: HTMLElement) => el.querySelector('[data-testid="builder-combobox"] input[role="combobox"]') as HTMLInputElement;
const submit = (el: HTMLElement) => (el.querySelector('[data-testid="issue-submit"]') as HTMLButtonElement).click();

describe('ApiKeyIssueModalComponent (#546)', () => {
  it('AC2: picks the builder from a combobox and sends its tenant key', async () => {
    const { el, api, ref, store } = await setup();
    type(nameInput(el), 'Bow production');

    const box = combobox(el);
    expect(box.getAttribute('role')).toBe('combobox');
    type(box, 'bow');
    TestBed.tick();
    const options = Array.from(el.querySelectorAll('[role="option"]'));
    expect(options.map((o) => o.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Bow River, bow-river']);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    TestBed.tick();
    expect(box.value).toBe('Bow River');

    submit(el);
    await vi.waitFor(() => expect(ref.close).toHaveBeenCalledWith(true));
    expect(api.issueApiKey).toHaveBeenCalledWith({
      name: 'Bow production',
      tenant_id: 'bow-river',
      scopes: ['estimate'],
      rate_limit: 60,
      sandbox: false,
    });
    expect(store.selectSnapshot(ApiKeysState.plaintext)).toBe('feasly_live_once');
  });

  it('omits the tenant id when no builder is picked', async () => {
    const { el, api } = await setup();
    type(nameInput(el), 'Partner');
    submit(el);
    await vi.waitFor(() => expect(api.issueApiKey).toHaveBeenCalled());
    expect(api.issueApiKey.mock.calls[0][0]).not.toHaveProperty('tenant_id');
  });

  it('blocks the submit without a name, a scope, or a valid rate limit', async () => {
    const { el, api } = await setup();
    // Untick the default scope; leave the name blank; break the rate limit.
    const estimate = Array.from(el.querySelectorAll<HTMLInputElement>('.issue-modal__scopes input')).find((i) =>
      i.parentElement?.textContent?.includes('estimate') && !i.parentElement.textContent.includes(':'),
    )!;
    estimate.click();
    const inputs = el.querySelectorAll<HTMLInputElement>('ui-text-field input');
    type(inputs[1], '0');
    submit(el);
    TestBed.tick();
    expect(api.issueApiKey).not.toHaveBeenCalled();
    const text = el.textContent ?? '';
    expect(text).toContain('Give the key a name.');
    expect(text).toContain('Pick at least one scope.');
    expect(text).toContain('Enter a whole number from 1 to 10000.');
  });

  it('keeps the modal open with an error when issuing fails', async () => {
    const { el, ref } = await setup({ fails: true });
    type(nameInput(el), 'Partner');
    submit(el);
    await vi.waitFor(() => expect(el.querySelector('[role="alert"]')?.textContent).toContain('Couldn’t issue the key'));
    expect(ref.close).not.toHaveBeenCalled();
  });
});
