import {
  Component,
  DestroyRef,
  Injector,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  FormBuilder,
  ReactiveFormsModule,
  Validators,
  type AbstractControl,
  type ValidationErrors,
} from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { startWith } from 'rxjs';
import type {
  BuilderEmbedOriginStatus,
  BuilderNotificationPreferences,
  BuilderProfile,
} from '@feasly/contracts';
import {
  ErrorStateComponent,
  KitDatePipe,
  KitDateTimePipe,
  KitRelativePipe,
  PageHeaderComponent,
  PageLayoutComponent,
  SkeletonComponent,
  UiButtonComponent,
  UiModalService,
  UiTextFieldComponent,
  UiToastService,
} from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { BUILDER_COPY } from './builder-copy';
import { BuilderState } from './builder.state';
import {
  BuilderSettingsState,
  ClearBuilderSettingsErrors,
  LoadBuilderEmbed,
  LoadBuilderNotificationPreferences,
  LoadBuilderProfile,
  SaveBuilderNotificationPreferences,
  SaveBuilderProfile,
} from './builder-settings.state';
import {
  BuilderOriginRequestModalComponent,
  type BuilderOriginRequestModalData,
  type BuilderOriginRequestModalResult,
} from './builder-origin-request-modal.component';

export type BuilderSettingsTab = 'profile' | 'notifications' | 'embed' | 'help';

const TABS: readonly BuilderSettingsTab[] = ['profile', 'notifications', 'embed', 'help'];

/** One email preference the member can toggle (#864). */
export type NotificationPreferenceKey = keyof BuilderNotificationPreferences;

/** `#rrggbb` — the API stores the same shape (lower-cased server-side). */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HTTPS_PREFIX_RE = /^https:\/\/\S+$/i;

/** Blank → null (clears an optional profile field). */
function nullIfBlank(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Blank is allowed; anything else must be an https link. */
function httpsValidator(control: AbstractControl<string>): ValidationErrors | null {
  const v = (control.value ?? '').trim();
  return v.length === 0 || HTTPS_PREFIX_RE.test(v) ? null : { https: true };
}

/** Install-check bucket for one allowed origin. */
export type OriginInstallState = 'live' | 'stale' | 'never';

export function originInstallState(origin: BuilderEmbedOriginStatus): OriginInstallState {
  if (origin.loadedRecently) return 'live';
  return origin.lastSeenAt ? 'stale' : 'never';
}

/**
 * Builder Settings page (#871, web half of #724; API in #870).
 *
 * Route `/builder/settings` (any org member). Three tabs (WAI-ARIA tabs;
 * `?tab=` keeps the choice across reloads):
 *
 * - **Profile & branding** — display name, contact email/phone, logo URL
 *   and accent colour with a live preview. Owners edit and save (toast);
 *   members — and owners viewing as a teammate — see the same fields
 *   read-only (`canEdit` from the API, which enforces it too).
 * - **Notifications** (#864) — new-lead email, daily "Needs you" digest and
 *   (admins only) billing emails, saved on toggle. Read-only while viewing
 *   as a teammate (the API answers 403); the last billing admin can't turn
 *   billing emails off (409 LAST_ADMIN — the API's message is shown).
 * - **Embed** — the install snippet with Copy, allowed websites read-only
 *   with a per-origin install check, open origin-change requests, and
 *   "Request a change" (owners) opening a dialog that files an admin task.
 * - **Help** — support email and response time (both from the API, never
 *   hardcoded) plus config-owned links to the guides.
 *
 * Every string comes from BUILDER_COPY; field caps from ConfigService.
 * noindex via the robots guard on the builder route group.
 */
@Component({
  selector: 'app-builder-settings',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    ErrorStateComponent,
    KitDateTimePipe,
    KitRelativePipe,
    PageHeaderComponent,
    PageLayoutComponent,
    SkeletonComponent,
    UiButtonComponent,
    UiTextFieldComponent,
  ],
  templateUrl: './builder-settings.component.html',
  styleUrls: ['./builder-settings.component.scss'],
})
export class BuilderSettingsComponent {
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly toasts = inject(UiToastService);
  private readonly modals = inject(UiModalService);
  private readonly limits = inject(ConfigService).get('limits');
  private readonly kitDate = new KitDatePipe();

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(BUILDER_COPY).settings;
  protected readonly retryLabel = inject(BUILDER_COPY).retryLabel;

  protected readonly profile = this.store.selectSignal(BuilderSettingsState.profile);
  protected readonly canEdit = this.store.selectSignal(BuilderSettingsState.canEdit);
  protected readonly support = this.store.selectSignal(BuilderSettingsState.support);
  protected readonly profileStatus = this.store.selectSignal(BuilderSettingsState.profileStatus);
  protected readonly saving = this.store.selectSignal(BuilderSettingsState.saving);
  protected readonly saveError = this.store.selectSignal(BuilderSettingsState.saveError);
  protected readonly embed = this.store.selectSignal(BuilderSettingsState.embed);
  protected readonly embedStatus = this.store.selectSignal(BuilderSettingsState.embedStatus);
  protected readonly notifications = this.store.selectSignal(BuilderSettingsState.notifications);
  protected readonly notificationsStatus = this.store.selectSignal(
    BuilderSettingsState.notificationsStatus,
  );
  protected readonly notificationsSaving = this.store.selectSignal(
    BuilderSettingsState.notificationsSaving,
  );
  protected readonly notificationsError = this.store.selectSignal(
    BuilderSettingsState.notificationsError,
  );
  private readonly viewAsBanner = this.store.selectSignal(BuilderState.viewAsBanner);

  /** First load failed (nothing to show yet) — offer retry. */
  protected readonly notificationsLoadFailed = computed(
    () => this.notificationsStatus() === 'error' && !this.notifications(),
  );

  /** Viewing as a teammate: their preferences are read-only (API 403s). */
  protected readonly notificationsReadOnly = computed(() => this.viewAsBanner() !== null);

  /**
   * The last billing admin can't turn billing emails off: the toggle is
   * locked (on) with an explanation instead of failing with a 409.
   */
  protected readonly billingLocked = computed(() => {
    const n = this.notifications();
    return !!n && n.preferences.billingEmail && !n.canDisableBillingEmail;
  });

  protected readonly tabs = TABS;
  protected readonly tab = signal<BuilderSettingsTab>(this.initialTab());

  protected readonly form = this.fb.nonNullable.group({
    displayName: [
      '',
      [Validators.required, Validators.maxLength(this.limits.builderDisplayNameMaxLength)],
    ],
    contactEmail: [
      '',
      [Validators.email, Validators.maxLength(this.limits.builderContactEmailMaxLength)],
    ],
    contactPhone: [''],
    logoUrl: ['', [httpsValidator, Validators.maxLength(this.limits.builderLogoUrlMaxLength)]],
    accentColor: ['', [Validators.pattern(HEX_COLOR_RE)]],
  });

  /** Live form value as a signal (drives the preview). */
  private readonly value = toSignal(
    this.form.valueChanges.pipe(startWith(this.form.getRawValue())),
    { initialValue: this.form.getRawValue() },
  );

  /** Brand colour for the preview when the field holds a valid hex. */
  protected readonly accentPreview = computed(() => {
    const v = (this.value().accentColor ?? '').trim();
    return HEX_COLOR_RE.test(v) ? v : null;
  });

  /** Logo for the preview when the field holds an https link. */
  protected readonly logoPreview = computed(() => {
    const v = (this.value().logoUrl ?? '').trim();
    return HTTPS_PREFIX_RE.test(v) ? v : null;
  });

  /** Preview name: the display name being typed, else the saved one. */
  protected readonly previewName = computed(
    () => nullIfBlank(this.value().displayName ?? '') ?? this.profile()?.displayName ?? '',
  );

  /** The preview image failed to load (CSP or a bad link). */
  protected readonly logoBroken = signal(false);

  /** Why the fields are read-only (null when the caller can edit). */
  protected readonly readOnlyNote = computed(() => {
    if (this.canEdit()) return null;
    return this.viewAsBanner() ? this.copy.profileViewAsNote : this.copy.profileReadOnlyNote;
  });

  protected readonly origins = computed(() =>
    (this.embed()?.origins ?? []).map((o) => ({ ...o, state: originInstallState(o) })),
  );

  protected readonly originsIntro = computed(() =>
    this.copy.originsIntro.replace('{days}', String(this.embed()?.liveWindowDays ?? '')),
  );

  protected readonly responseTime = computed(() => {
    const time = this.support()?.responseTime;
    return time ? this.copy.helpResponseTime.replace('{time}', time) : null;
  });

  constructor() {
    this.store
      .dispatch([
        new LoadBuilderProfile(),
        new LoadBuilderEmbed(),
        new LoadBuilderNotificationPreferences(),
      ])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();

    // Fill the form whenever a (new) profile arrives; lock it for members.
    effect(() => {
      const profile = this.profile();
      const canEdit = this.canEdit();
      if (profile) this.resetForm(profile);
      if (canEdit) this.form.enable({ emitEvent: false });
      else this.form.disable({ emitEvent: false });
    });

    this.form.controls.logoUrl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.logoBroken.set(false));
  }

  private initialTab(): BuilderSettingsTab {
    const requested = this.route.snapshot.queryParamMap.get('tab');
    return TABS.find((t) => t === requested) ?? 'profile';
  }

  protected tabLabel(tab: BuilderSettingsTab): string {
    if (tab === 'notifications') return this.copy.tabNotifications;
    if (tab === 'embed') return this.copy.tabEmbed;
    if (tab === 'help') return this.copy.tabHelp;
    return this.copy.tabProfile;
  }

  protected selectTab(tab: BuilderSettingsTab): void {
    this.tab.set(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: tab === 'profile' ? null : tab },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** ←/→ (and Home/End) move between tabs (WAI-ARIA tabs pattern). */
  protected onTabKeydown(event: KeyboardEvent): void {
    const index = TABS.indexOf(this.tab());
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    this.selectTab(TABS[next]);
    const buttons = (event.currentTarget as HTMLElement | null)?.querySelectorAll<HTMLElement>(
      '[role="tab"]',
    );
    buttons?.[next]?.focus();
  }

  protected retryProfile(): void {
    this.store
      .dispatch(new LoadBuilderProfile())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected retryEmbed(): void {
    this.store
      .dispatch(new LoadBuilderEmbed())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected retryNotifications(): void {
    this.store
      .dispatch(new LoadBuilderNotificationPreferences())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /**
   * Save one toggle. Server state wins: on failure (409/403/network) the
   * checkbox snaps back to the last saved value and the error shows inline.
   */
  protected toggleNotification(key: NotificationPreferenceKey, event: Event): void {
    const input = event.target as HTMLInputElement;
    const current = this.notifications();
    if (!current || this.notificationsReadOnly() || this.notificationsSaving()) {
      if (current) input.checked = current.preferences[key];
      return;
    }
    const checked = input.checked;
    this.store
      .dispatch(new SaveBuilderNotificationPreferences({ [key]: checked }))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        const saved = this.store.selectSnapshot(BuilderSettingsState.notifications);
        if (saved) input.checked = saved.preferences[key];
        if (this.store.selectSnapshot(BuilderSettingsState.notificationsError) === null) {
          this.toasts.show({ message: this.copy.notificationsSavedToast });
        }
      });
  }

  /** Field-level error text (plain language, never validator jargon). */
  protected fieldError(name: keyof typeof this.form.controls): string | null {
    const control = this.form.controls[name];
    if (!control.touched || control.valid || control.disabled) return null;
    const errors = control.errors ?? {};
    if (errors['required']) return this.copy.errorRequired;
    if (errors['maxlength']) {
      return this.copy.errorTooLong.replace(
        '{max}',
        String((errors['maxlength'] as { requiredLength: number }).requiredLength),
      );
    }
    if (errors['email']) return this.copy.errorEmail;
    if (errors['https']) return this.copy.errorHttps;
    if (errors['pattern']) return this.copy.errorHex;
    return this.copy.errorRequired;
  }

  protected save(): void {
    if (!this.canEdit() || this.saving()) return;
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const v = this.form.getRawValue();
    this.store
      .dispatch(
        new SaveBuilderProfile({
          displayName: v.displayName.trim(),
          contactEmail: nullIfBlank(v.contactEmail),
          contactPhone: nullIfBlank(v.contactPhone),
          logoUrl: nullIfBlank(v.logoUrl),
          accentColor: nullIfBlank(v.accentColor),
        }),
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.store.selectSnapshot(BuilderSettingsState.saveError) === null) {
          this.toasts.show({ message: this.copy.savedToast });
        }
      });
  }

  protected discard(): void {
    const profile = this.profile();
    if (profile) this.resetForm(profile);
    this.store.dispatch(new ClearBuilderSettingsErrors());
  }

  private resetForm(profile: BuilderProfile): void {
    this.form.reset(
      {
        displayName: profile.displayName,
        contactEmail: profile.contactEmail ?? '',
        contactPhone: profile.contactPhone ?? '',
        logoUrl: profile.logoUrl ?? '',
        accentColor: profile.accentColor ?? '',
      },
      { emitEvent: true },
    );
  }

  protected copySnippet(): void {
    const snippet = this.embed()?.snippet;
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!snippet || !clipboard) {
      this.toasts.show({ message: this.copy.copyFailedToast, tone: 'warning' });
      return;
    }
    clipboard.writeText(snippet).then(
      () => this.toasts.show({ message: this.copy.copiedToast }),
      () => this.toasts.show({ message: this.copy.copyFailedToast, tone: 'warning' }),
    );
  }

  protected openRequestChange(): void {
    const embed = this.embed();
    if (!embed || !this.canEdit()) return;
    this.store.dispatch(new ClearBuilderSettingsErrors());
    const ref = this.modals.open<
      BuilderOriginRequestModalComponent,
      BuilderOriginRequestModalResult,
      BuilderOriginRequestModalData
    >(BuilderOriginRequestModalComponent, {
      data: { origins: embed.origins.map((o) => o.origin) },
      injector: this.injector,
    });
    ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((outcome) => {
      if (outcome === 'created') this.toasts.show({ message: this.copy.requestCreatedToast });
      else if (outcome === 'duplicate') {
        this.toasts.show({ message: this.copy.requestDuplicateToast, tone: 'info' });
      }
    });
  }

  /** "Requested Nov 15, 2026" (Edmonton calendar). */
  protected filedLabel(createdAt: string): string {
    return this.copy.openRequestFiled.replace('{date}', this.kitDate.transform(createdAt));
  }

  /** App routes use the router; anything else opens in a new tab. */
  protected isInternal(href: string): boolean {
    return href.startsWith('/');
  }
}
