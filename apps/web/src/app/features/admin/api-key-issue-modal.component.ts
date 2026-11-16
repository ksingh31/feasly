import { DialogRef } from '@angular/cdk/dialog';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Store } from '@ngxs/store';
import { startWith } from 'rxjs';
import type { ApiKeyScope } from '@feasly/contracts';
import {
  EntityComboboxComponent,
  UiButtonComponent,
  UiModalComponent,
  UiTextFieldComponent,
} from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { AdminBuildersState } from './admin-builders.state';
import { API_KEY_SCOPES, IssueApiKey } from './api-keys.actions';
import { ApiKeysState } from './api-keys.state';
import { builderOptions, fill, parseRateLimit, rateLimitValidator, scopesValidator } from './api-keys-view';
import { injectAdminCopy } from './admin-copy';

/**
 * Issue-key modal (#546, review S13): name, builder (EntityCombobox over
 * the builders list — AC2, no pasted tenant ids), scopes, rate limit and
 * sandbox. Closes with `true` once the key is issued; the page then opens
 * the one-time secret modal from the plaintext in state.
 */
@Component({
  selector: 'app-api-key-issue-modal',
  standalone: true,
  imports: [ReactiveFormsModule, UiModalComponent, UiButtonComponent, UiTextFieldComponent, EntityComboboxComponent],
  templateUrl: './api-key-issue-modal.component.html',
  styleUrl: './api-key-issue-modal.component.scss',
})
export class ApiKeyIssueModalComponent {
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly ref = inject<DialogRef<boolean>>(DialogRef);
  private readonly config = inject(ConfigService);

  protected readonly copy = injectAdminCopy().apiKeys;
  private readonly rateLimitMax = this.config.get('admin').rateLimitMax;
  protected readonly rateLimitError = fill(this.copy.rateLimitError, { max: this.rateLimitMax });
  protected readonly scopes: readonly ApiKeyScope[] = API_KEY_SCOPES;

  private readonly builders = this.store.selectSignal(AdminBuildersState.builders);
  protected readonly builderOptions = computed(() => builderOptions(this.builders()));
  protected readonly mutating = this.store.selectSignal(ApiKeysState.mutating);
  protected readonly issueFailed = signal(false);

  protected readonly form = this.fb.group({
    name: this.fb.nonNullable.control('', [Validators.required, Validators.pattern(/\S/), Validators.maxLength(this.config.get('admin').apiKeyNameMax)]),
    tenantId: this.fb.control<string | null>(null),
    scopes: this.fb.nonNullable.control<readonly ApiKeyScope[]>(['estimate'], [scopesValidator]),
    rateLimit: this.fb.nonNullable.control(String(this.config.get('admin').defaultRateLimit), [
      rateLimitValidator(this.rateLimitMax),
    ]),
    sandbox: this.fb.nonNullable.control(false),
  });

  private readonly scopesValue = toSignal(
    this.form.controls.scopes.valueChanges.pipe(startWith(this.form.controls.scopes.value)),
    { initialValue: this.form.controls.scopes.value },
  );

  protected hasScope(scope: ApiKeyScope): boolean {
    return this.scopesValue().includes(scope);
  }

  protected toggleScope(scope: ApiKeyScope): void {
    const control = this.form.controls.scopes;
    const current = control.value;
    control.setValue(current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope]);
    control.markAsTouched();
  }

  protected toggleSandbox(event: Event): void {
    this.form.controls.sandbox.setValue((event.target as HTMLInputElement).checked);
  }

  protected error(name: 'name' | 'rateLimit' | 'scopes'): string | null {
    const control = this.form.controls[name];
    if (!control.touched || control.valid) return null;
    if (name === 'name') return this.copy.nameError;
    if (name === 'rateLimit') return this.rateLimitError;
    return this.copy.scopesError;
  }

  protected cancel(): void {
    this.ref.close(false);
  }

  protected submit(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.mutating()) return;
    const v = this.form.getRawValue();
    this.issueFailed.set(false);
    this.store
      .dispatch(
        new IssueApiKey({
          name: v.name.trim(),
          ...(v.tenantId ? { tenant_id: v.tenantId } : {}),
          scopes: v.scopes,
          rate_limit: parseRateLimit(v.rateLimit) ?? undefined,
          sandbox: v.sandbox,
        }),
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.ref.close(true),
        error: () => this.issueFailed.set(true),
      });
  }
}
