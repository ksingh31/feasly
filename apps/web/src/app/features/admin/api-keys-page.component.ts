import { DialogRef } from '@angular/cdk/dialog';
import {
  Component,
  DestroyRef,
  Injector,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import type { ApiKeyRecordResponse } from '@feasly/contracts';
import {
  DataTableComponent,
  type DataTableColumn,
  KitDateTimePipe,
  KitRelativePipe,
  PageHeaderComponent,
  UI_DRAWER_URL_PARAM,
  UiButtonComponent,
  UiCellDirective,
  UiDrawerService,
  UiModalService,
  UiRowActionsDirective,
  injectDrawerParam,
} from '@app/shared/ui';
import { LoadBuilders } from './admin-builders.actions';
import { AdminBuildersState } from './admin-builders.state';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';
import { ClearPlaintext, LoadApiKeys } from './api-keys.actions';
import { ApiKeysState } from './api-keys.state';
import { ApiKeyDrawerComponent, type ApiKeyDrawerData } from './api-key-drawer.component';
import { ApiKeyIssueModalComponent } from './api-key-issue-modal.component';
import { ApiKeySecretModalComponent } from './api-key-secret-modal.component';
import { apiKeyStatus, builderName } from './api-keys-view';
import { injectAdminCopy } from './admin-copy';

/** A key row with its builder name resolved for display. */
export interface ApiKeyRow extends ApiKeyRecordResponse {
  readonly status: 'active' | 'revoked';
  readonly builderName: string | null;
}

/**
 * Admin API keys (api-mcp/02; redesign #546, review S13) — `/admin/api-keys`.
 *
 * Kit DataTable (Name · Builder · Prefix · Scopes chips · Last used · Status)
 * that becomes a card list on phones. A row opens the key drawer
 * (`?open=<id>`: Overview + Usage tabs). "Issue key" opens the issue modal
 * (builder picked from a combobox). Whenever a plaintext lands in state
 * (issue or rotate), the one-time secret modal opens — it can't be
 * dismissed by the scrim, Esc or a ×; only "Done" after the acknowledgment.
 *
 * ApiKeysState is provided at this route via lazyProvider and is not
 * persisted: the once-only plaintext never survives a refresh, and it is
 * cleared when the page is left.
 */
@Component({
  selector: 'app-api-keys-page',
  standalone: true,
  imports: [
    PageHeaderComponent,
    DataTableComponent,
    UiCellDirective,
    UiRowActionsDirective,
    UiButtonComponent,
    KitRelativePipe,
    KitDateTimePipe,
  ],
  templateUrl: './api-keys-page.component.html',
  styleUrl: './api-keys-page.component.scss',
})
export class ApiKeysPageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly drawers = inject(UiDrawerService);
  private readonly modals = inject(UiModalService);

  protected readonly copy = injectAdminCopy().apiKeys;

  private readonly keys = this.store.selectSignal(ApiKeysState.keys);
  private readonly builders = this.store.selectSignal(AdminBuildersState.builders);
  protected readonly loading = this.store.selectSignal(ApiKeysState.loading);
  protected readonly loadFailed = this.store.selectSignal(ApiKeysState.loadFailed);
  private readonly plaintext = this.store.selectSignal(ApiKeysState.plaintext);

  /** `api_keys:manage` — viewers get the table and a read-only drawer. */
  protected readonly canManage = adminCan(this.store, ADMIN_PERMISSIONS.apiKeysManage);

  /** `?open=<id>` — the key whose drawer is open. */
  protected readonly openId = injectDrawerParam();

  protected readonly rows = computed<readonly ApiKeyRow[]>(() =>
    this.keys().map((k) => ({
      ...k,
      status: apiKeyStatus(k),
      builderName: builderName(k.tenant_id, this.builders()),
    })),
  );

  protected readonly rowId = (k: ApiKeyRow): string => k.id;

  protected readonly columns: readonly DataTableColumn<ApiKeyRow>[] = [
    { key: 'name', header: this.copy.colName, cardRole: 'title' },
    { key: 'builder', header: this.copy.colBuilder, value: (k) => k.builderName ?? this.copy.noBuilder, cardRole: 'meta' },
    { key: 'prefix', header: this.copy.colPrefix, kind: 'id', value: (k) => k.key_prefix, cardRole: 'meta' },
    { key: 'scopes', header: this.copy.colScopes, value: (k) => k.scopes.join(', '), cardRole: 'hidden' },
    { key: 'lastUsed', header: this.copy.colLastUsed, value: (k) => k.last_used_at, cardRole: 'meta' },
    { key: 'status', header: this.copy.colStatus, kind: 'status', statusDomain: 'apiKey', cardRole: 'chip' },
  ];

  /** The first LoadApiKeys on this page has settled. */
  private readonly loaded = signal(false);
  private secretRef: DialogRef<unknown, ApiKeySecretModalComponent> | null = null;

  constructor() {
    // Deep links and Back/Forward drive the drawer off the URL once the
    // list is loaded; a param naming an unknown key is dropped.
    effect(() => {
      const id = this.openId();
      const ready = this.loaded();
      untracked(() => this.syncDrawer(id, ready));
    });
    // A fresh plaintext (issue or rotate) opens the one-time secret modal.
    effect(() => {
      const plaintext = this.plaintext();
      untracked(() => {
        if (plaintext && !this.secretRef) this.openSecret();
      });
    });
  }

  ngOnInit(): void {
    this.store
      .dispatch(new LoadApiKeys())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.loaded.set(true),
        error: () => this.loaded.set(true),
      });
    // Builder names for the table and the issue modal's picker.
    this.store.dispatch(new LoadBuilders()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ error: () => undefined });
    // Leaving the page loses the once-only plaintext for good.
    this.destroyRef.onDestroy(() => {
      this.secretRef?.close();
      this.store.dispatch(new ClearPlaintext());
    });
  }

  protected retry(): void {
    this.store.dispatch(new LoadApiKeys());
  }

  protected issue(): void {
    this.modals.open<ApiKeyIssueModalComponent, boolean>(ApiKeyIssueModalComponent, {
      size: 'md',
      injector: this.injector,
    });
  }

  protected openKey(key: ApiKeyRow): void {
    this.openDrawer(key.id);
  }

  private syncDrawer(id: string | null, ready: boolean): void {
    if (id === null || !ready || this.drawers.openDrawer?.urlId === id) return;
    if (!this.keys().some((k) => k.id === id)) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { [UI_DRAWER_URL_PARAM]: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
      return;
    }
    this.openDrawer(id);
  }

  private openDrawer(keyId: string): void {
    this.drawers.open<ApiKeyDrawerComponent, void, ApiKeyDrawerData>(ApiKeyDrawerComponent, {
      data: { keyId, canManage: this.canManage() },
      size: 'md',
      urlId: keyId,
      injector: this.injector,
    });
  }

  private openSecret(): void {
    const ref = this.modals.open<ApiKeySecretModalComponent>(ApiKeySecretModalComponent, {
      size: 'md',
      // AC1: a scrim click (or swipe / Esc) must never lose the key.
      dismissOnScrim: false,
      dismissOnEsc: false,
      injector: this.injector,
    });
    this.secretRef = ref;
    ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.secretRef = null;
      // Closed without Done (e.g. navigation): the key is still gone for good.
      if (this.plaintext()) this.store.dispatch(new ClearPlaintext());
    });
  }
}
