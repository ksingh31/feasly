import { DIALOG_DATA } from '@angular/cdk/dialog';
import { Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Store } from '@ngxs/store';
import type {
  AdminBuilderPartner,
  BuilderPartnerCreateBody,
  BuilderPartnerUpdateBody,
} from '@feasly/contracts';
import {
  StatusChipComponent,
  UiButtonComponent,
  UiDrawerComponent,
  UiDrawerRef,
  UiTextFieldComponent,
} from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { fill } from './admin-leads-view';
import { injectAdminCopy } from './admin-copy';
import { CreateAdminPartner, UpdateAdminPartner } from './admin-partners.actions';
import { AdminPartnersState } from './admin-partners.state';

/** What the Partners page hands the drawer: null = add a new partner. */
export interface AdminPartnerDrawerData {
  readonly partnerId: string | null;
}

/** Logo and website must be https URLs (the backend re-checks). */
const HTTPS_URL = /^https:\/\/\S+$/i;

/** The saved partner, or null when nothing changed. */
export type AdminPartnerDrawerResult = AdminBuilderPartner | null;

/**
 * Add or edit a builder partner (#919) — one form in a `ui-drawer` with
 * one sticky [Cancel] [Save] footer: name, logo URL, website, short
 * description and (on add) whether it starts active.
 *
 * Edit sends one PATCH carrying only the changed fields; an emptied
 * optional field is sent as null (clears it). The drawer closes with the
 * saved partner on success; a failure keeps it open with the backend's
 * message above the footer. Esc / scrim / × / Cancel ask before
 * discarding unsaved edits (drawer dirty guard).
 */
@Component({
  selector: 'app-admin-partner-drawer',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    UiDrawerComponent,
    UiButtonComponent,
    UiTextFieldComponent,
    StatusChipComponent,
  ],
  templateUrl: './admin-partner-drawer.component.html',
  styleUrl: './admin-partner-drawer.component.scss',
})
export class AdminPartnerDrawerComponent {
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly ref = inject<UiDrawerRef<AdminPartnerDrawerResult>>(UiDrawerRef);
  protected readonly data = inject<AdminPartnerDrawerData>(DIALOG_DATA);

  protected readonly saving = this.store.selectSignal(AdminPartnersState.saving);
  protected readonly saveError = this.store.selectSignal(AdminPartnersState.saveError);

  /** The partner as loaded when the drawer opened (null = adding). */
  protected readonly partner: AdminBuilderPartner | null =
    this.data.partnerId === null
      ? null
      : (this.store
          .selectSnapshot(AdminPartnersState.partners)
          .find((p) => p.id === this.data.partnerId) ?? null);

  /** Name/description caps (`limits`) — mirror the #896 service validation. */
  private readonly limits = inject(ConfigService).get('limits');
  protected readonly copy = injectAdminCopy().partners;
  protected readonly descriptionMax = this.limits.partnerDescriptionMaxLength;

  protected readonly form = this.fb.nonNullable.group({
    name: [
      this.partner?.name ?? '',
      [Validators.required, Validators.maxLength(this.limits.partnerNameMaxLength)],
    ],
    logoUrl: [this.partner?.logoUrl ?? '', [Validators.pattern(HTTPS_URL)]],
    websiteUrl: [this.partner?.websiteUrl ?? '', [Validators.pattern(HTTPS_URL)]],
    description: [
      this.partner?.description ?? '',
      [Validators.maxLength(this.limits.partnerDescriptionMaxLength)],
    ],
    active: [this.partner?.active ?? true],
  });

  protected get heading(): string {
    return this.partner ? `Edit ${this.partner.name}` : 'Add partner';
  }

  /** Field error, shown once the field was touched (or Save was pressed). */
  protected fieldError(field: 'name' | 'logoUrl' | 'websiteUrl' | 'description'): string | null {
    const control = this.form.controls[field];
    if (!control.touched || control.valid) return null;
    switch (field) {
      case 'name':
        return control.hasError('required')
          ? 'Enter the company name.'
          : fill(this.copy.nameTooLong, { max: this.limits.partnerNameMaxLength });
      case 'description':
        return fill(this.copy.descriptionTooLong, { max: this.descriptionMax });
      default:
        return 'Enter a full https:// address.';
    }
  }

  protected save(): void {
    if (this.saving()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const partner = this.partner;
    if (this.data.partnerId !== null && !partner) return;
    if (partner) {
      const body = this.changes(partner);
      if (Object.keys(body).length === 0) {
        this.ref.close(null);
        return;
      }
      this.dispatch(new UpdateAdminPartner(partner.id, body), partner.id);
    } else {
      this.dispatch(new CreateAdminPartner(this.createBody()), null);
    }
  }

  protected cancel(): void {
    this.ref.requestClose();
  }

  private dispatch(action: CreateAdminPartner | UpdateAdminPartner, id: string | null): void {
    const before = new Set(this.store.selectSnapshot(AdminPartnersState.partners).map((p) => p.id));
    this.store
      .dispatch(action)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          const partners = this.store.selectSnapshot(AdminPartnersState.partners);
          const saved =
            id !== null
              ? partners.find((p) => p.id === id)
              : partners.find((p) => !before.has(p.id));
          this.ref.close(saved ?? null);
        },
        // The state holds the message; the drawer stays open to show it.
        error: () => undefined,
      });
  }

  private values() {
    const raw = this.form.getRawValue();
    const optional = (value: string): string | null => value.trim() || null;
    return {
      name: raw.name.trim(),
      logoUrl: optional(raw.logoUrl),
      websiteUrl: optional(raw.websiteUrl),
      description: optional(raw.description),
      active: raw.active,
    };
  }

  private createBody(): BuilderPartnerCreateBody {
    return this.values();
  }

  /** Only the fields that differ from the loaded partner. */
  private changes(partner: AdminBuilderPartner): BuilderPartnerUpdateBody {
    const v = this.values();
    return {
      ...(v.name !== partner.name ? { name: v.name } : {}),
      ...(v.logoUrl !== partner.logoUrl ? { logoUrl: v.logoUrl } : {}),
      ...(v.websiteUrl !== partner.websiteUrl ? { websiteUrl: v.websiteUrl } : {}),
      ...(v.description !== partner.description ? { description: v.description } : {}),
      ...(v.active !== partner.active ? { active: v.active } : {}),
    };
  }
}
