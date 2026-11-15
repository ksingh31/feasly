import { DIALOG_DATA } from '@angular/cdk/dialog';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { Store } from '@ngxs/store';
import { startWith } from 'rxjs';
import type {
  Builder,
  BuilderCreateBody,
  BuilderPaymentMethod,
  BuilderStatus,
  BuilderUpdateBody,
} from '@feasly/contracts';
import {
  StatusChipComponent,
  UiButtonComponent,
  UiDrawerComponent,
  UiDrawerRef,
  UiFieldShellComponent,
  UiSelectComponent,
  type UiSelectOption,
  UiTextFieldComponent,
  UiToastService,
} from '@app/shared/ui';
import {
  CreateBuilder,
  DismissBuildersSaved,
  DismissBuildersSaveError,
  LoadAdminBuilderAgreement,
  UpdateBuilder,
} from './admin-builders.actions';
import { formatEdmontonMediumDate } from '@app/shared/utils/edmonton';
import { AdminBuildersState } from './admin-builders.state';
import { PLANNED_PAYMENT_METHOD_LABELS } from './admin-billing-api.service';
import {
  HEX_COLOR_RE,
  PLAN_OPTIONS,
  STATUS_OPTIONS,
  TENANT_KEY_RE,
  jsonObjectValidator,
  nullIfBlank,
  parseOrigins,
  rateLabel,
  readBuilderDefaultPaymentMethod,
  settingsText,
} from './admin-builders-view';

export interface AdminBuilderDrawerData {
  /** Builder to edit; null opens the blank "Add builder" form. */
  readonly builderId: string | null;
}

/** Commission rate range accepted by the backend (percent). */
const RATE_MIN = 0;
const RATE_MAX = 10;

/** Rate text → percent number, or null when blank / not a number. */
function parseRate(raw: string | null | undefined): number | null {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Blank is allowed (create → server default, edit → unchanged); else 0–10. */
function rateValidator(control: AbstractControl): ValidationErrors | null {
  const raw = String(control.value ?? '').trim();
  if (raw.length === 0) return null;
  const n = parseRate(raw);
  return n === null || n < RATE_MIN || n > RATE_MAX ? { rateRange: true } : null;
}

/**
 * Admin builder drawer (#541, review S7). Opens from the Builders table
 * (row click or "Edit", `?open=<id>`) or the "Add builder" button, with
 * sections Identity · Contact · Branding (logo + colour preview) ·
 * Commercial · Embed origins, and the raw settings JSON behind an
 * "Advanced" disclosure with validation.
 *
 * A commission-rate edit shows the before → after rate and that it only
 * applies to invoices created from now on (AC1). Every write goes through
 * the existing CreateBuilder / UpdateBuilder actions; no rules live here.
 */
@Component({
  selector: 'app-admin-builder-drawer',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    UiDrawerComponent,
    UiButtonComponent,
    UiTextFieldComponent,
    UiSelectComponent,
    UiFieldShellComponent,
    StatusChipComponent,
  ],
  templateUrl: './admin-builder-drawer.component.html',
  styleUrl: './admin-builder-drawer.component.scss',
})
export class AdminBuilderDrawerComponent {
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toasts = inject(UiToastService);
  private readonly data = inject<AdminBuilderDrawerData>(DIALOG_DATA);
  protected readonly ref = inject(UiDrawerRef);

  protected readonly saving = this.store.selectSignal(AdminBuildersState.saving);
  protected readonly saveError = this.store.selectSignal(AdminBuildersState.saveError);
  /** #722: the platform-agreement block (edit only). */
  protected readonly agreement = this.store.selectSignal(AdminBuildersState.agreement);
  protected readonly agreementStatus = this.store.selectSignal(AdminBuildersState.agreementStatus);
  protected readonly agreementAcceptedAt = computed(() => {
    const at = this.agreement()?.acceptedAt;
    return at ? formatEdmontonMediumDate(at) : null;
  });
  protected readonly agreementAcceptedBy = computed(() => {
    const by = this.agreement()?.acceptedBy;
    if (!by) return null;
    if (by.name && by.email) return `${by.name} (${by.email})`;
    return by.name ?? by.email ?? null;
  });

  /** The builder being edited (snapshot at open), or null when adding. */
  protected readonly builder: Builder | null =
    this.data.builderId === null
      ? null
      : (this.store.selectSnapshot(AdminBuildersState.builders).find((b) => b.id === this.data.builderId) ?? null);

  protected readonly isEdit = this.builder !== null;

  protected readonly tenantKeyHint = this.isEdit
    ? 'Locked — the sign-in key can’t change after creation.'
    : 'Lowercase letters, numbers, and dashes (e.g. elite-craft).';

  protected readonly statusOptions: readonly UiSelectOption[] = STATUS_OPTIONS;
  /** '' (undecided) maps to the select's placeholder (null). */
  protected readonly planOptions: readonly UiSelectOption[] = PLAN_OPTIONS.filter((o) => o.value !== '');
  protected readonly undecidedLabel = PLAN_OPTIONS[0].label;
  protected readonly methodOptions: readonly UiSelectOption[] = PLANNED_PAYMENT_METHOD_LABELS;

  /** Advanced (JSON) disclosure; opens itself when its field blocks a save. */
  protected readonly advancedOpen = signal(false);
  /** The logo URL failed to load in the preview. */
  protected readonly logoBroken = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    businessName: ['', [Validators.required, Validators.maxLength(200)]],
    displayName: ['', [Validators.required, Validators.maxLength(200)]],
    tenantKey: ['', [Validators.required, Validators.maxLength(100), Validators.pattern(TENANT_KEY_RE)]],
    status: ['active' as string, [Validators.required]],
    email: ['', [Validators.email, Validators.maxLength(320)]],
    phone: ['', [Validators.maxLength(50)]],
    logoUrl: ['', [Validators.maxLength(2000)]],
    accentColor: ['', [Validators.pattern(HEX_COLOR_RE)]],
    plan: [null as string | null],
    /** Negotiated commission rate in PERCENT (billing/08); 1 = the 1% default. */
    commissionRate: ['1', [rateValidator]],
    /** Default payment method for new invoices (billing/12). */
    defaultPaymentMethod: ['card' as string, [Validators.required]],
    allowedOrigins: [''],
    settings: ['', [jsonObjectValidator]],
  });

  /** Live form value as a signal (previews + before/after). */
  private readonly value = toSignal(this.form.valueChanges.pipe(startWith(this.form.getRawValue())), {
    initialValue: this.form.getRawValue(),
  });

  /** Brand colour swatch when the field holds a valid hex. */
  protected readonly accentPreview = computed(() => {
    const v = (this.value().accentColor ?? '').trim();
    return HEX_COLOR_RE.test(v) ? v : null;
  });

  protected readonly logoPreview = computed(() => nullIfBlank(this.value().logoUrl));

  /**
   * AC1: before → after for a commission-rate edit. Only on edit, only
   * when the field holds a valid rate that differs from the saved one.
   */
  protected readonly rateChange = computed<{ before: string; after: string } | null>(() => {
    if (!this.builder) return null;
    const raw = this.value().commissionRate;
    if (rateValidator({ value: raw } as AbstractControl) !== null) return null;
    const next = parseRate(raw);
    if (next === null || next === this.builder.commissionRatePercent) return null;
    return { before: rateLabel(this.builder.commissionRatePercent), after: rateLabel(next) };
  });

  protected readonly originCount = computed(() => parseOrigins(this.value().allowedOrigins).length);

  constructor() {
    this.store.dispatch(new DismissBuildersSaveError());
    const b = this.builder;
    if (b) {
      this.store.dispatch(new LoadAdminBuilderAgreement(b.id));
      this.form.reset({
        businessName: b.businessName,
        displayName: b.displayName,
        tenantKey: b.tenantKey,
        status: b.status,
        email: b.email ?? '',
        phone: b.phone ?? '',
        logoUrl: b.logoUrl ?? '',
        accentColor: b.accentColor ?? '',
        plan: b.plan ?? null,
        commissionRate: String(b.commissionRatePercent ?? 1),
        defaultPaymentMethod: readBuilderDefaultPaymentMethod(b.settings),
        allowedOrigins: b.allowedOrigins.join('\n'),
        settings: settingsText(b.settings),
      });
      // The sign-in key is the builder's identity everywhere (embeds,
      // sessions, billing) — it cannot change after creation.
      this.form.controls.tenantKey.disable();
    }
    this.form.controls.logoUrl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.logoBroken.set(false));
  }

  protected heading(): string {
    return this.builder?.businessName ?? 'Add builder';
  }

  protected dismissSaveError(): void {
    this.store.dispatch(new DismissBuildersSaveError());
  }

  protected toggleAdvanced(event: Event): void {
    this.advancedOpen.set((event.target as HTMLDetailsElement).open);
  }

  /** Field-level error text (buyer-grade, not validator jargon). */
  protected fieldError(name: keyof typeof this.form.controls): string | null {
    const control = this.form.controls[name];
    if (!control.touched || control.valid || control.disabled) return null;
    const errors = control.errors ?? {};
    if (errors['required']) return 'This field is required.';
    if (errors['email']) return 'Enter a valid email address.';
    if (errors['maxlength']) return `Keep it under ${errors['maxlength'].requiredLength} characters.`;
    if (errors['pattern']) {
      if (name === 'tenantKey') return 'Use lowercase letters, numbers, and dashes only (e.g. elite-craft).';
      if (name === 'accentColor') return 'Use a #rrggbb hex color (e.g. #C8A24B), or leave blank.';
      return 'The format is not valid.';
    }
    if (errors['jsonInvalid']) return 'Settings must be valid JSON (or leave blank).';
    if (errors['jsonObject']) return 'Settings must be a JSON object, like { "key": "value" }.';
    if (errors['rateRange']) return 'Enter a rate between 0 and 10 percent.';
    return 'This field is not valid.';
  }

  protected save(): void {
    this.form.markAllAsTouched();
    if (this.form.controls.settings.invalid) this.advancedOpen.set(true);
    if (this.form.invalid || this.saving()) return;

    const v = this.form.getRawValue();
    const settingsRaw = v.settings.trim();
    const settings: Record<string, unknown> =
      settingsRaw.length === 0 ? {} : (JSON.parse(settingsRaw) as Record<string, unknown>);
    const rate = parseRate(v.commissionRate);
    const method = v.defaultPaymentMethod as BuilderPaymentMethod;
    const common = {
      businessName: v.businessName.trim(),
      displayName: v.displayName.trim(),
      email: nullIfBlank(v.email),
      phone: nullIfBlank(v.phone),
      logoUrl: nullIfBlank(v.logoUrl),
      accentColor: nullIfBlank(v.accentColor),
      allowedOrigins: parseOrigins(v.allowedOrigins),
      plan: v.plan ?? null,
      status: v.status as BuilderStatus,
      // Blank = server default on create, unchanged on edit. 0 is a real rate.
      ...(rate !== null ? { commissionRatePercent: rate } : {}),
    };

    const builder = this.builder;
    const action = builder
      ? new UpdateBuilder(builder.id, {
          ...common,
          settings,
          // The dedicated field wins over a stale value inside the settings JSON.
          defaultPaymentMethod: method,
        } satisfies BuilderUpdateBody)
      : new CreateBuilder({
          ...common,
          tenantKey: v.tenantKey.trim(),
          // The create endpoint has no dedicated field — it rides in settings.
          settings: { ...settings, defaultPaymentMethod: method },
        } satisfies BuilderCreateBody);
    const message = builder ? 'Builder saved.' : 'Builder added.';

    this.store
      .dispatch(action)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          if (!this.store.selectSnapshot(AdminBuildersState.saved)) return;
          this.store.dispatch(new DismissBuildersSaved());
          this.toasts.show({ message });
          this.ref.close(true);
        },
        // The failure lives in state (saveError); the drawer renders it.
        error: () => undefined,
      });
  }
}
