import { DIALOG_DATA } from '@angular/cdk/dialog';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Store } from '@ngxs/store';
import { filter, startWith, switchMap } from 'rxjs';
import type { ApiKeyRecordResponse, ApiKeyScope } from '@feasly/contracts';
import {
  KeyValueListComponent,
  type KeyValueItem,
  StatusChipComponent,
  UiButtonComponent,
  UiConfirmService,
  UiDrawerComponent,
  UiDrawerRef,
  UiTextFieldComponent,
  UiToastService,
} from '@app/shared/ui';
import { formatRelativeTime } from '../../shared/utils/datetime';
import { formatEdmontonMediumDate } from '../../shared/utils/edmonton';
import { ConfigService } from '../../core/config/config.service';
import { AdminBuildersState } from './admin-builders.state';
import { API_KEY_SCOPES, RevokeApiKey, RotateApiKey, SelectApiKey, UpdateApiKey } from './api-keys.actions';
import { ApiKeysState } from './api-keys.state';
import { ApiKeyUsageComponent } from './api-key-usage.component';
import {
  apiKeyStatus,
  builderName,
  fill,
  parseRateLimit,
  rateLimitValidator,
  scopesValidator,
} from './api-keys-view';
import { injectAdminCopy } from './admin-copy';

export interface ApiKeyDrawerData {
  readonly keyId: string;
  /** `api_keys:manage` — viewers see the key read-only. */
  readonly canManage: boolean;
}

export type ApiKeyDrawerTab = 'overview' | 'usage';

/**
 * API key drawer (#546, review S13), opened from the API keys table
 * (`?open=<id>`). Tabs: Overview (details, scope + rate-limit editor,
 * rotate / revoke behind confirm dialogs) and Usage (per-day chart, table
 * collapsed). A rotate closes the drawer; the page then shows the new key
 * in the one-time secret modal.
 */
@Component({
  selector: 'app-api-key-drawer',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    UiDrawerComponent,
    UiButtonComponent,
    UiTextFieldComponent,
    StatusChipComponent,
    KeyValueListComponent,
    ApiKeyUsageComponent,
  ],
  templateUrl: './api-key-drawer.component.html',
  styleUrl: './api-key-drawer.component.scss',
})
export class ApiKeyDrawerComponent {
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly confirms = inject(UiConfirmService);
  private readonly toasts = inject(UiToastService);
  private readonly config = inject(ConfigService);
  private readonly data = inject<ApiKeyDrawerData>(DIALOG_DATA);
  protected readonly ref = inject(UiDrawerRef);

  protected readonly copy = injectAdminCopy().apiKeys;
  private readonly rateLimitMax = this.config.get('admin').rateLimitMax;
  protected readonly scopes: readonly ApiKeyScope[] = API_KEY_SCOPES;
  protected readonly canManage = this.data.canManage;

  private readonly keys = this.store.selectSignal(ApiKeysState.keys);
  private readonly builders = this.store.selectSignal(AdminBuildersState.builders);
  protected readonly mutating = this.store.selectSignal(ApiKeysState.mutating);

  /** Live record (updates after a save); the open-time snapshot if it disappears. */
  private readonly snapshot: ApiKeyRecordResponse | null =
    this.store.selectSnapshot(ApiKeysState.keys).find((k) => k.id === this.data.keyId) ?? null;
  protected readonly key = computed(() => this.keys().find((k) => k.id === this.data.keyId) ?? this.snapshot);
  protected readonly status = computed(() => (this.key() ? apiKeyStatus(this.key()!) : null));
  protected readonly editable = computed(() => this.canManage && this.status() === 'active');

  protected readonly tab = signal<ApiKeyDrawerTab>('overview');
  protected readonly actionFailed = signal<string | null>(null);

  protected readonly details = computed<readonly KeyValueItem[]>(() => {
    const k = this.key();
    if (!k) return [];
    const items: KeyValueItem[] = [
      { label: this.copy.builderLabel, value: builderName(k.tenant_id, this.builders()) ?? this.copy.noBuilder },
      { label: this.copy.prefixLabel, value: k.key_prefix },
      { label: this.copy.modeLabel, value: k.sandbox ? this.copy.modeSandbox : this.copy.modeLive },
      { label: this.copy.createdLabel, value: formatEdmontonMediumDate(k.created_at) },
      {
        label: this.copy.lastUsedLabel,
        value: k.last_used_at ? formatRelativeTime(k.last_used_at) : this.copy.never,
      },
    ];
    if (k.revoked_at) items.push({ label: this.copy.revokedAtLabel, value: formatEdmontonMediumDate(k.revoked_at) });
    return items;
  });

  protected readonly form = this.fb.nonNullable.group({
    scopes: this.fb.nonNullable.control<readonly ApiKeyScope[]>([], [scopesValidator]),
    rateLimit: ['', [rateLimitValidator(this.rateLimitMax)]],
  });

  private readonly scopesValue = toSignal(
    this.form.controls.scopes.valueChanges.pipe(startWith(this.form.controls.scopes.value)),
    { initialValue: this.form.controls.scopes.value },
  );

  constructor() {
    this.store.dispatch(new SelectApiKey(this.data.keyId));
    this.resetForm();
    this.ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.store.dispatch(new SelectApiKey(null));
    });
  }

  protected heading(): string {
    return this.key()?.name ?? this.copy.title;
  }

  protected selectTab(tab: ApiKeyDrawerTab): void {
    this.tab.set(tab);
  }

  /** ←/→ (and Home/End) move between the two tabs (WAI-ARIA tabs pattern). */
  protected onTabKeydown(event: KeyboardEvent): void {
    const order: readonly ApiKeyDrawerTab[] = ['overview', 'usage'];
    const index = order.indexOf(this.tab());
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % order.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + order.length) % order.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = order.length - 1;
    if (next === null) return;
    event.preventDefault();
    this.tab.set(order[next]);
    const host = (event.currentTarget as HTMLElement | null)?.querySelectorAll<HTMLElement>('[role="tab"]');
    host?.[next]?.focus();
  }

  protected hasScope(scope: ApiKeyScope): boolean {
    return this.scopesValue().includes(scope);
  }

  protected toggleScope(scope: ApiKeyScope): void {
    const control = this.form.controls.scopes;
    const current = control.value;
    control.setValue(current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope]);
    control.markAsDirty();
    control.markAsTouched();
  }

  protected error(name: 'scopes' | 'rateLimit'): string | null {
    const control = this.form.controls[name];
    if (!control.touched || control.valid) return null;
    return name === 'scopes' ? this.copy.scopesError : fill(this.copy.rateLimitError, { max: this.rateLimitMax });
  }

  protected save(): void {
    const k = this.key();
    if (!k || !this.editable()) return;
    this.form.markAllAsTouched();
    if (this.form.invalid || this.mutating()) return;
    const v = this.form.getRawValue();
    this.actionFailed.set(null);
    this.store
      .dispatch(new UpdateApiKey(k.id, { scopes: v.scopes, rate_limit_per_min: parseRateLimit(v.rateLimit) ?? undefined }))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.resetForm();
          this.toasts.show({ message: this.copy.savedToast });
        },
        error: () => this.actionFailed.set(this.copy.saveError),
      });
  }

  protected rotate(): void {
    const k = this.key();
    if (!k || !this.editable()) return;
    this.confirms
      .confirm({
        title: fill(this.copy.rotateConfirmTitle, { name: k.name }),
        body: this.copy.rotateConfirm,
        verb: this.copy.rotateButton,
        cancelLabel: this.copy.cancelButton,
        tone: 'danger',
      })
      .pipe(
        filter(Boolean),
        switchMap(() => this.store.dispatch(new RotateApiKey(k.id))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        // The page opens the one-time secret modal from the new plaintext.
        next: () => this.ref.close(),
        error: () => this.actionFailed.set(this.copy.actionError),
      });
  }

  protected revoke(): void {
    const k = this.key();
    if (!k || !this.editable()) return;
    this.confirms
      .confirm({
        title: fill(this.copy.revokeConfirmTitle, { name: k.name }),
        body: this.copy.revokeConfirm,
        verb: this.copy.revokeButton,
        cancelLabel: this.copy.cancelButton,
        tone: 'danger',
      })
      .pipe(
        filter(Boolean),
        switchMap(() => this.store.dispatch(new RevokeApiKey(k.id))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.toasts.show({ message: this.copy.revokedToast });
          this.ref.close();
        },
        error: () => this.actionFailed.set(this.copy.actionError),
      });
  }

  private resetForm(): void {
    const k = this.key();
    this.form.reset({ scopes: k ? [...k.scopes] : [], rateLimit: k ? String(k.rate_limit_per_min) : '' });
  }
}
