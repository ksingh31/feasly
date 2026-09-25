import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import type { ApiKeyScope } from '@feasly/contracts';
import {
  API_KEY_SCOPES,
  ClearPlaintext,
  IssueApiKey,
  LoadApiKeyUsage,
  LoadApiKeys,
  RevokeApiKey,
  RotateApiKey,
  SelectApiKey,
  UpdateApiKey,
} from './api-keys.actions';
import { ApiKeysState } from './api-keys.state';
import { ApiKeyUsageComponent } from './api-key-usage.component';

/**
 * API key management (story api-mcp/02).
 *
 * `/admin/api-keys` — Karan's key lifecycle UI: issue (plaintext shown
 * once with a copy button — navigating away loses it permanently), rotate /
 * revoke with confirm dialogs, scope + rate-limit editors (take effect on
 * the next request, no restart), and a per-key usage panel.
 *
 * Guarded by {@link adminGuard} (interim X-Admin-Key until admin/01).
 * State lives in {@link ApiKeysState} (not persisted — the once-only
 * plaintext must never survive a refresh).
 */
@Component({
  selector: 'app-api-keys-page',
  standalone: true,
  imports: [FormsModule, SiteFooterComponent, SiteNavComponent, ApiKeyUsageComponent],
  templateUrl: './api-keys-page.component.html',
  styleUrl: './api-keys-page.component.scss',
})
export class ApiKeysPageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly copy = this.config.get('copy').admin.apiKeys;
  protected readonly scopes: readonly ApiKeyScope[] = API_KEY_SCOPES;

  // NGXS selectors
  protected readonly keys = this.store.selectSignal(ApiKeysState.keys);
  protected readonly selected = this.store.selectSignal(ApiKeysState.selected);
  protected readonly plaintext = this.store.selectSignal(ApiKeysState.plaintext);
  protected readonly loading = this.store.selectSignal(ApiKeysState.loading);
  protected readonly loadFailed = this.store.selectSignal(ApiKeysState.loadFailed);

  // Issue form state
  protected readonly showIssueForm = signal(false);
  protected readonly issueName = signal('');
  protected readonly issueTenant = signal('');
  protected readonly issueScopes = signal<readonly ApiKeyScope[]>(['estimate']);
  protected readonly issueRateLimit = signal(this.config.get('admin').defaultRateLimit);
  protected readonly issueSandbox = signal(false);

  // Edit state (for the selected key)
  protected readonly editing = signal(false);
  protected readonly editScopes = signal<readonly ApiKeyScope[]>([]);
  protected readonly editRateLimit = signal(this.config.get('admin').defaultRateLimit);

  // Confirm dialog state: 'rotate' | 'revoke' | null
  protected readonly confirmAction = signal<'rotate' | 'revoke' | null>(null);
  protected readonly copied = signal(false);

  ngOnInit(): void {
    // Matches the `admin/**` noindex pattern in seo-routes.ts.
    this.seo.setForRoute('admin/api-keys');
    this.store.dispatch(new LoadApiKeys());
    // Clear the once-only plaintext when leaving the page.
    this.destroyRef.onDestroy(() => {
      this.store.dispatch(new ClearPlaintext());
    });
  }

  protected selectKey(id: string | null): void {
    this.editing.set(false);
    this.store.dispatch(new SelectApiKey(id));
    if (id) {
      this.store.dispatch(new LoadApiKeyUsage(id));
    }
  }

  protected toggleScope(list: 'issue' | 'edit', scope: ApiKeyScope): void {
    const current = list === 'issue' ? this.issueScopes() : this.editScopes();
    const next = current.includes(scope)
      ? current.filter((s) => s !== scope)
      : [...current, scope];
    if (list === 'issue') {
      this.issueScopes.set(next);
    } else {
      this.editScopes.set(next);
    }
  }

  protected issue(): void {
    const name = this.issueName().trim();
    if (!name || this.issueScopes().length === 0) return;
    this.copied.set(false);
    this.store
      .dispatch(
        new IssueApiKey({
          name,
          tenant_id: this.issueTenant().trim() || undefined,
          scopes: this.issueScopes(),
          rate_limit: this.issueRateLimit(),
          sandbox: this.issueSandbox(),
        }),
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.showIssueForm.set(false);
        this.issueName.set('');
        this.issueTenant.set('');
        this.issueScopes.set(['estimate']);
        this.issueRateLimit.set(this.config.get('admin').defaultRateLimit);
        this.issueSandbox.set(false);
      });
  }

  protected copyPlaintext(): void {
    const text = this.plaintext();
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => this.copied.set(true))
      .catch(() => this.copied.set(false));
  }

  protected dismissPlaintext(): void {
    this.store.dispatch(new ClearPlaintext());
  }

  protected requestRotate(): void {
    this.confirmAction.set('rotate');
  }

  protected requestRevoke(): void {
    this.confirmAction.set('revoke');
  }

  protected confirmDialog(): void {
    const action = this.confirmAction();
    const key = this.selected();
    if (!action || !key) {
      this.confirmAction.set(null);
      return;
    }
    this.confirmAction.set(null);
    if (action === 'rotate') {
      this.copied.set(false);
      this.store.dispatch(new RotateApiKey(key.id));
    } else {
      this.store.dispatch(new RevokeApiKey(key.id));
    }
  }

  protected cancelDialog(): void {
    this.confirmAction.set(null);
  }

  protected startEdit(): void {
    const key = this.selected();
    if (!key) return;
    this.editScopes.set([...key.scopes]);
    this.editRateLimit.set(key.rate_limit_per_min);
    this.editing.set(true);
  }

  protected cancelEdit(): void {
    this.editing.set(false);
  }

  protected saveEdit(): void {
    const key = this.selected();
    if (!key || this.editScopes().length === 0) return;
    this.store
      .dispatch(
        new UpdateApiKey(key.id, {
          scopes: this.editScopes(),
          rate_limit_per_min: this.editRateLimit(),
        }),
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.editing.set(false));
  }
}
