/**
 * One-time secret modal (#546, review S13): no ×, a copy button, and Done
 * locked until "I've stored it" is ticked; Done clears the plaintext.
 */
import { DialogRef } from '@angular/cdk/dialog';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Store, provideStore } from '@ngxs/store';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_SERVICE } from '../../core/api/api.service';
import { ApiKeySecretModalComponent } from './api-key-secret-modal.component';
import { IssueApiKey } from './api-keys.actions';
import { ApiKeysState } from './api-keys.state';

async function setup() {
  const ref = { close: vi.fn() };
  const api = {
    issueApiKey: vi.fn(() =>
      of({ key: { id: 'k', name: 'Elite production' }, plaintext: 'feasly_live_once' }),
    ),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideStore([ApiKeysState]),
      { provide: API_SERVICE, useValue: api },
      { provide: DialogRef, useValue: ref },
    ],
  });
  const store = TestBed.inject(Store);
  store.dispatch(new IssueApiKey({ name: 'Elite production' }));
  const fixture = TestBed.createComponent(ApiKeySecretModalComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  return { ref, store, el: fixture.nativeElement as HTMLElement };
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement;

describe('ApiKeySecretModalComponent (#546)', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('shows the key and the key name, with no close button', async () => {
    const { el } = await setup();
    expect((q(el, 'secret-value') as HTMLInputElement).value).toBe('feasly_live_once');
    expect(el.textContent).toContain('Elite production');
    expect(el.textContent).toContain('only time the full key is shown');
    expect(el.querySelector('.ui-modal__close')).toBeNull();
  });

  it('copies the key to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { el } = await setup();
    q(el, 'copy-secret').click();
    await vi.waitFor(() => expect(q(el, 'copy-secret').textContent).toContain('Copied'));
    expect(writeText).toHaveBeenCalledWith('feasly_live_once');
  });

  it('says so when the copy fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
      configurable: true,
    });
    const { el } = await setup();
    q(el, 'copy-secret').click();
    await vi.waitFor(() => expect(el.textContent).toContain('copy it by hand'));
  });

  it('keeps Done locked until the acknowledgment, then clears the plaintext', async () => {
    const { el, ref, store } = await setup();
    const done = q(el, 'secret-done') as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    done.click();
    expect(ref.close).not.toHaveBeenCalled();

    (q(el, 'secret-ack') as HTMLInputElement).click();
    TestBed.tick();
    expect(done.disabled).toBe(false);
    done.click();
    expect(ref.close).toHaveBeenCalled();
    expect(store.selectSnapshot(ApiKeysState.plaintext)).toBeNull();
  });
});
