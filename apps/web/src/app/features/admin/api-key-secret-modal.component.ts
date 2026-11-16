import { DialogRef } from '@angular/cdk/dialog';
import { Component, inject, signal } from '@angular/core';
import { Store } from '@ngxs/store';
import { UiButtonComponent, UiModalComponent } from '@app/shared/ui';
import { ClearPlaintext } from './api-keys.actions';
import { ApiKeysState } from './api-keys.state';
import { injectAdminCopy } from './admin-copy';

/**
 * One-time secret modal (#546, review S13). Shows the plaintext from the
 * last issue/rotate with a copy button and an "I've stored it"
 * acknowledgment that unlocks Done.
 *
 * Opened by the API keys page with `dismissOnScrim: false` and
 * `dismissOnEsc: false`, and rendered without the ×: Done is the only way
 * out, so a stray click can't lose the key (AC1). Done clears the
 * plaintext from state — the backend never returns it again.
 */
@Component({
  selector: 'app-api-key-secret-modal',
  standalone: true,
  imports: [UiModalComponent, UiButtonComponent],
  templateUrl: './api-key-secret-modal.component.html',
  styleUrl: './api-key-secret-modal.component.scss',
})
export class ApiKeySecretModalComponent {
  private readonly store = inject(Store);
  private readonly ref = inject(DialogRef);
  protected readonly copy = injectAdminCopy().apiKeys;

  protected readonly plaintext = this.store.selectSignal(ApiKeysState.plaintext);
  protected readonly keyName = this.store.selectSignal(ApiKeysState.plaintextKeyName);

  protected readonly copyState = signal<'idle' | 'copied' | 'failed'>('idle');
  protected readonly acknowledged = signal(false);

  protected copyKey(): void {
    const text = this.plaintext();
    if (!text) return;
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) {
      this.copyState.set('failed');
      return;
    }
    clipboard.writeText(text).then(
      () => this.copyState.set('copied'),
      () => this.copyState.set('failed'),
    );
  }

  protected onAck(event: Event): void {
    this.acknowledged.set((event.target as HTMLInputElement).checked);
  }

  /** Select the whole key on focus/click so a manual copy is one keystroke. */
  protected selectAll(event: Event): void {
    (event.target as HTMLInputElement).select();
  }

  protected done(): void {
    if (!this.acknowledged()) return;
    this.store.dispatch(new ClearPlaintext());
    this.ref.close();
  }
}
