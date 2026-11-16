import { Component, DestroyRef, computed, effect, inject, input, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import { KitCountPipe } from '@app/shared/ui';
import { LoadApiKeyUsage } from './api-keys.actions';
import { ApiKeysState } from './api-keys.state';
import { fill, usageByDay } from './api-keys-view';
import { injectAdminCopy } from './admin-copy';

/**
 * Usage panel for one API key (api-mcp/07; redesign #546, review S13): a
 * small bar chart of requests per day, with the per-endpoint daily table
 * collapsed under a disclosure. Loads when the key id changes.
 */
@Component({
  selector: 'app-api-key-usage',
  standalone: true,
  imports: [KitCountPipe],
  templateUrl: './api-key-usage.component.html',
  styleUrl: './api-key-usage.component.scss',
})
export class ApiKeyUsageComponent {
  readonly keyId = input.required<string>();

  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly copy = injectAdminCopy().apiKeys;

  protected readonly usage = this.store.selectSignal(ApiKeysState.usage);
  protected readonly loading = this.store.selectSignal(ApiKeysState.usageLoading);
  protected readonly days = computed(() => usageByDay(this.usage()));
  protected readonly total = computed(() =>
    fill(this.copy.usageTotal, {
      count: this.days().reduce((sum, d) => sum + d.count, 0).toLocaleString('en-CA'),
      days: this.days().length,
    }),
  );

  constructor() {
    effect(() => {
      const id = this.keyId();
      untracked(() =>
        this.store.dispatch(new LoadApiKeyUsage(id)).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(),
      );
    });
  }
}
