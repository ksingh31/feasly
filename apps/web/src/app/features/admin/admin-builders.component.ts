import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { Store } from '@ngxs/store';
import type {
  Builder,
  BuilderCreateBody,
  BuilderPaymentMethod,
  BuilderStatus,
  BuilderUpdateBody,
} from '@feasly/contracts';
import { initials } from '../../shared/utils/initials';
import {
  CreateBuilder,
  DismissBuildersError,
  DismissBuildersSaved,
  DismissBuildersSaveError,
  LoadBuilders,
  UpdateBuilder,
} from './admin-builders.actions';
import { AdminBuildersState } from './admin-builders.state';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';
import {
  PLANNED_PAYMENT_METHOD_LABELS,
} from './admin-billing-api.service';
import {
  isBuilderPaymentMethod,
} from '../builder/builder-payment-methods';

/** Tenant-key shape enforced by the backend (lowercase alphanumeric with dashes). */
const TENANT_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Backend accent-color shape (#rrggbb hex). */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Builder plan options — '' = undecided (stored as null). */
const PLAN_OPTIONS = [
  { value: '', label: 'Undecided' },
  { value: 'flat', label: 'Flat — monthly fee' },
  { value: 'commission', label: 'Commission — share of signed builds' },
] as const;

/** Default payment method for new invoices (billing/12), stored on settings. */
function readBuilderDefaultPaymentMethod(
  settings: Record<string, unknown> | null | undefined,
): BuilderPaymentMethod {
  const raw = settings?.['defaultPaymentMethod'];
  return isBuilderPaymentMethod(raw) ? raw : 'card';
}

/** Valid JSON (or empty) for the advanced settings field. */
function jsonValidator(control: AbstractControl): ValidationErrors | null {
  const raw = (control.value ?? '').trim();
  if (raw.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { jsonObject: true };
    }
    return null;
  } catch {
    return { jsonInvalid: true };
  }
}

/**
 * Admin builders management (embed/02 admin-UI migration).
 *
 * `/admin/builders` — the builders table: who receives leads, their
 * branding, login key (tenantKey, immutable after creation), and which
 * websites may load their embed. Create + edit inline; `tenantKey` is
 * create-only because embeds, sessions, and billing join on it.
 */
@Component({
  selector: 'app-admin-builders',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './admin-builders.component.html',
  styleUrl: './admin-builders.component.scss',
})
export class AdminBuildersComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  // NGXS selectors
  protected readonly builders = this.store.selectSignal(AdminBuildersState.builders);
  protected readonly listStatus = this.store.selectSignal(AdminBuildersState.listStatus);
  protected readonly listError = this.store.selectSignal(AdminBuildersState.listError);
  protected readonly saving = this.store.selectSignal(AdminBuildersState.saving);
  protected readonly saveError = this.store.selectSignal(AdminBuildersState.saveError);
  protected readonly saved = this.store.selectSignal(AdminBuildersState.saved);

  /**
   * Add/edit builder are `builders:manage` writes — read-only staff see
   * the table without the add/edit affordances.
   */
  protected readonly canManageBuilders = adminCan(
    this.store,
    ADMIN_PERMISSIONS.buildersManage,
  );

  protected readonly planOptions = PLAN_OPTIONS;

  /** Planned payment-method options for the default-method dropdown. */
  protected readonly paymentMethodOptions = PLANNED_PAYMENT_METHOD_LABELS;

  /** Logo images that failed to load — those avatars fall back to initials. */
  protected readonly logoFailed = signal<ReadonlySet<string>>(new Set());

  /** Form visible + which builder is being edited (null = creating). */
  protected readonly showForm = signal(false);
  protected readonly editing = signal<Builder | null>(null);
  protected readonly savedMessage = signal('');

  protected readonly form = this.fb.group({
    businessName: ['', [Validators.required, Validators.maxLength(200)]],
    displayName: ['', [Validators.required, Validators.maxLength(200)]],
    tenantKey: [
      '',
      [Validators.required, Validators.maxLength(100), Validators.pattern(TENANT_KEY_RE)],
    ],
    email: ['', [Validators.email, Validators.maxLength(320)]],
    phone: ['', [Validators.maxLength(50)]],
    logoUrl: ['', [Validators.maxLength(2000)]],
    accentColor: ['', [Validators.pattern(HEX_COLOR_RE)]],
    allowedOrigins: [''],
    plan: [''],
    status: ['active' as BuilderStatus, [Validators.required]],
    /**
     * Negotiated commission rate, in PERCENT (billing/08). 1 = the 1%
     * default. 0 is a legitimate negotiated outcome; the backend rejects
     * anything outside 0–10.
     */
    commissionRatePercent: [
      1,
      [Validators.min(0), Validators.max(10)],
    ],
    /**
     * Default payment method for new invoices (billing/12). 'card' = the
     * card on file with the Stripe auto-charge; the manual options pause
     * it. On create it merges into the settings JSON; on edit the backend
     * also accepts it as a dedicated field (dedicated wins).
     */
    defaultPaymentMethod: [
      'card' as BuilderPaymentMethod,
      [Validators.required],
    ],
    settings: ['', [jsonValidator]],
  });

  ngOnInit(): void {
    this.store.dispatch(new LoadBuilders());
  }

  protected retry(): void {
    this.store.dispatch(new LoadBuilders());
  }

  protected dismissListError(): void {
    this.store.dispatch(new DismissBuildersError());
  }

  protected dismissSaveError(): void {
    this.store.dispatch(new DismissBuildersSaveError());
  }

  protected dismissSaved(): void {
    this.savedMessage.set('');
    this.store.dispatch(new DismissBuildersSaved());
  }

  /** Open the blank create form. */
  protected startCreate(): void {
    this.editing.set(null);
    this.form.reset({
      businessName: '',
      displayName: '',
      tenantKey: '',
      email: '',
      phone: '',
      logoUrl: '',
      accentColor: '',
      allowedOrigins: '',
      plan: '',
      status: 'active',
      commissionRatePercent: 1,
      defaultPaymentMethod: 'card' as BuilderPaymentMethod,
      settings: '',
    });
    this.form.get('tenantKey')?.enable();
    this.savedMessage.set('');
    this.store.dispatch(new DismissBuildersSaveError());
    this.showForm.set(true);
  }

  /** Open the edit form prefilled from a builder row. */
  // FUTURE (builder onboarding story): the portal-access email manager
  // hooks in here — the builder_allowlist table and the /builder/login
  // magic-link flow already exist; this form will list/grant/revoke
  // allowlisted emails per builder once self-serve onboarding is scoped.
  protected startEdit(builder: Builder): void {
    this.editing.set(builder);
    this.form.reset({
      businessName: builder.businessName,
      displayName: builder.displayName,
      tenantKey: builder.tenantKey,
      email: builder.email ?? '',
      phone: builder.phone ?? '',
      logoUrl: builder.logoUrl ?? '',
      accentColor: builder.accentColor ?? '',
      allowedOrigins: builder.allowedOrigins.join('\n'),
      plan: builder.plan ?? '',
      status: builder.status,
      commissionRatePercent: builder.commissionRatePercent,
      defaultPaymentMethod: readBuilderDefaultPaymentMethod(builder.settings),
      settings: Object.keys(builder.settings).length > 0 ? JSON.stringify(builder.settings, null, 2) : '',
    });
    // Tenant key is the builder's identity everywhere (embeds, sessions,
    // billing) — it cannot change after creation.
    this.form.get('tenantKey')?.disable();
    this.savedMessage.set('');
    this.store.dispatch(new DismissBuildersSaveError());
    this.showForm.set(true);
  }

  protected cancelForm(): void {
    this.showForm.set(false);
    this.editing.set(null);
    this.store.dispatch(new DismissBuildersSaveError());
  }

  /** True when the accent-color field holds a valid hex (for the preview swatch). */
  protected accentPreview(): string | null {
    const value = (this.form.get('accentColor')?.value ?? '').trim();
    return HEX_COLOR_RE.test(value) ? value : null;
  }

  /** Field-level error text for the template (buyer-grade, not validator jargon). */
  protected fieldError(name: string): string | null {
    const control = this.form.get(name);
    if (!control || !control.touched || control.valid) {
      return null;
    }
    const errors = control.errors ?? {};
    if (errors['required']) {
      return 'This field is required.';
    }
    if (errors['email']) {
      return 'Enter a valid email address.';
    }
    if (errors['maxlength']) {
      return `Keep it under ${errors['maxlength'].requiredLength} characters.`;
    }
    if (errors['pattern']) {
      if (name === 'tenantKey') {
        return 'Use lowercase letters, numbers, and dashes only (e.g. elite-craft).';
      }
      if (name === 'accentColor') {
        return 'Use a #rrggbb hex color (e.g. #C8A24B), or leave blank.';
      }
      return 'The format is not valid.';
    }
    if (errors['jsonInvalid']) {
      return 'Settings must be valid JSON (or leave blank).';
    }
    if (errors['jsonObject']) {
      return 'Settings must be a JSON object, like { "key": "value" }.';
    }
    if (errors['min'] || errors['max']) {
      return 'Enter a rate between 0 and 10 percent.';
    }
    return 'This field is not valid.';
  }

  protected save(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.saving()) {
      return;
    }
    const v = this.form.getRawValue();

    const origins = (v.allowedOrigins ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const settingsRaw = (v.settings ?? '').trim();
    const settings: Record<string, unknown> =
      settingsRaw.length === 0 ? {} : (JSON.parse(settingsRaw) as Record<string, unknown>);

    const nullIfBlank = (value: string | null | undefined): string | null => {
      const trimmed = (value ?? '').trim();
      return trimmed.length === 0 ? null : trimmed;
    };

    const editing = this.editing();
    if (editing) {
      const body: BuilderUpdateBody = {
        businessName: v.businessName!.trim(),
        displayName: v.displayName!.trim(),
        email: nullIfBlank(v.email),
        phone: nullIfBlank(v.phone),
        logoUrl: nullIfBlank(v.logoUrl),
        accentColor: nullIfBlank(v.accentColor),
        allowedOrigins: origins,
        plan: v.plan === '' ? null : v.plan,
        status: v.status!,
        settings,
        // The default method ships as the dedicated field (it wins over a
        // stale value inside the wholesale settings JSON above).
        defaultPaymentMethod: v.defaultPaymentMethod!,
        // A cleared field means "no change" — 0 is a real rate, so only
        // null is omitted.
        ...(v.commissionRatePercent !== null
          ? { commissionRatePercent: v.commissionRatePercent! }
          : {}),
      };
      this.savedMessage.set('Builder saved.');
      this.store
        .dispatch(new UpdateBuilder(editing.id, body))
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: () => {
            if (this.store.selectSnapshot(AdminBuildersState.saved)) {
              this.showForm.set(false);
              this.editing.set(null);
            }
          },
          // The failure already lives in state (saveError) — the banner
          // renders it. Nothing more to do here.
          error: () => undefined,
        });
    } else {
      const body: BuilderCreateBody = {
        tenantKey: v.tenantKey!.trim(),
        businessName: v.businessName!.trim(),
        displayName: v.displayName!.trim(),
        email: nullIfBlank(v.email),
        phone: nullIfBlank(v.phone),
        logoUrl: nullIfBlank(v.logoUrl),
        accentColor: nullIfBlank(v.accentColor),
        allowedOrigins: origins,
        plan: v.plan === '' ? null : v.plan,
        status: v.status!,
        // The create endpoint has no dedicated field — the default
        // payment method merges into the settings JSON it already sends.
        settings: {
          ...settings,
          defaultPaymentMethod: v.defaultPaymentMethod!,
        },
        // Blank on create falls back to the 1% default server-side.
        ...(v.commissionRatePercent !== null
          ? { commissionRatePercent: v.commissionRatePercent! }
          : {}),
      };
      this.savedMessage.set('Builder added.');
      this.store
        .dispatch(new CreateBuilder(body))
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: () => {
            if (this.store.selectSnapshot(AdminBuildersState.saved)) {
              this.showForm.set(false);
              this.editing.set(null);
            }
          },
          // The failure already lives in state (saveError) — the banner
          // renders it. Nothing more to do here.
          error: () => undefined,
        });
    }
  }

  protected planLabel(plan: string | null): string {
    const found = PLAN_OPTIONS.find((o) => o.value === (plan ?? ''));
    return found && found.value !== '' ? found.label : 'Undecided';
  }

  protected methodLabel(settings: Record<string, unknown>): string {
    const method = readBuilderDefaultPaymentMethod(settings);
    return (
      this.paymentMethodOptions.find((o) => o.value === method)?.label ?? method
    );
  }

  protected statusLabel(status: BuilderStatus): string {
    return status === 'active' ? 'Active' : 'Inactive';
  }

  /**
   * Commission rate cell, e.g. "1%". The contract guarantees the field,
   * but a missing value (stale cache) renders as the 1% default.
   */
  protected rateLabel(ratePercent: number | undefined): string {
    const rounded = Math.round((ratePercent ?? 1) * 10_000) / 10_000;
    return `${Number(rounded.toFixed(4))}%`;
  }

  /** Initials avatar (wordmark fallback) when the builder has no logo. */
  protected initials(name: string): string {
    return initials(name);
  }

  /** A broken logo URL falls back to the initials avatar, same as no logo. */
  protected onLogoError(builderId: string): void {
    this.logoFailed.update((failed) => new Set(failed).add(builderId));
  }
}
