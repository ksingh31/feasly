import { Component, DestroyRef, inject, input, OnChanges } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config/config.service';
import { LoadApiKeyUsage } from './api-keys.actions';
import { ApiKeysState } from './api-keys.state';

/**
 * Per-day usage table for an API key (api-mcp/02 + api-mcp/07).
 *
 * Reads from {@link ApiKeysState.usage}; dispatches a load when the key ID
 * changes. Pure presentational — the parent owns selection.
 */
@Component({
  selector: 'app-api-key-usage',
  standalone: true,
  templateUrl: './api-key-usage.component.html',
  styleUrl: './api-key-usage.component.scss',
})
export class ApiKeyUsageComponent implements OnChanges {
  readonly keyId = input.required<string>();

  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly config = inject(ConfigService);

  protected readonly copy = {
    loading: this.config.get('copy').admin.apiKeys.usageLoading,
    empty: this.config.get('copy').admin.apiKeys.usageEmpty,
    dateHeader: this.config.get('copy').admin.apiKeys.usageDateHeader,
    endpointHeader: this.config.get('copy').admin.apiKeys.usageEndpointHeader,
    requestsHeader: this.config.get('copy').admin.apiKeys.usageRequestsHeader,
    estimatesHeader: this.config.get('copy').admin.apiKeys.usageEstimatesHeader,
  };

  protected readonly usage = this.store.selectSignal(ApiKeysState.usage);
  protected readonly loading = this.store.selectSignal(ApiKeysState.usageLoading);

  ngOnChanges(): void {
    this.store
      .dispatch(new LoadApiKeyUsage(this.keyId()))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }
}
