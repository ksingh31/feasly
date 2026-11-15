import { DIALOG_DATA } from '@angular/cdk/dialog';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { BuilderLeadListItem, BuilderLeadStatus } from '@feasly/contracts';
import {
  KitDatePipe,
  StatusChipComponent,
  UiButtonComponent,
  UiModalComponent,
  UiSelectComponent,
  type UiSelectOption,
} from '@app/shared/ui';
import { BUILDER_COPY } from './builder-copy';
import { BuilderLeadCommentsComponent } from './builder-lead-comments.component';
import { UpdateBuilderLeadStatus } from './builder.actions';
import { BuilderState } from './builder.state';
import {
  PIPELINE_STATUSES,
  fill,
  heatChipLabel,
  heatLevel,
  mailtoHref,
  projectTypeLabel,
  telHref,
} from './builder-leads-view';

export interface BuilderLeadPanelData {
  readonly leadId: string;
}

/**
 * Lead quick view (#527): opened from a pipeline row via the kit Modal
 * (bottom sheet on phones). Carries what the old lead card did — contact
 * links, the staged status change with Apply (no auto-save, Karan
 * 2026-09-29), the won/recorded hints and the notes thread — until the
 * lead drawer story replaces it.
 *
 * Reads the lead live from BuilderState so a confirmed status change
 * re-renders in place.
 */
@Component({
  selector: 'app-builder-lead-panel',
  standalone: true,
  imports: [
    RouterLink,
    UiModalComponent,
    UiButtonComponent,
    UiSelectComponent,
    StatusChipComponent,
    KitDatePipe,
    BuilderLeadCommentsComponent,
  ],
  templateUrl: './builder-lead-panel.component.html',
  styleUrl: './builder-lead-panel.component.scss',
})
export class BuilderLeadPanelComponent {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly data = inject<BuilderLeadPanelData>(DIALOG_DATA);

  protected readonly copy = inject(BUILDER_COPY);
  protected readonly home = this.copy.leadsHome;
  protected readonly statusOptions: readonly UiSelectOption[] = PIPELINE_STATUSES.map((status) => ({
    value: status,
    label: this.copy.statusLabels[status],
  }));

  private readonly leads = this.store.selectSignal(BuilderState.leads);
  protected readonly updatingLeadId = this.store.selectSignal(BuilderState.updatingLeadId);
  private readonly storeUpdateError = this.store.selectSignal(BuilderState.updateError);
  protected readonly isAdmin = this.store.selectSignal(BuilderState.isBuilderAdmin);
  /** True once this panel dispatched an Apply — scopes the global updateError to this lead. */
  private readonly appliedHere = signal(false);
  protected readonly updateError = computed(() =>
    this.appliedHere() ? this.storeUpdateError() : null,
  );

  protected readonly lead = computed<BuilderLeadListItem | null>(
    () => this.leads().find((l) => l.id === this.data.leadId) ?? null,
  );

  /** Staged (unapplied) status pick; null = show the stored status. */
  protected readonly pending = signal<BuilderLeadStatus | null>(null);

  protected readonly shownStatus = computed(() => this.pending() ?? this.lead()?.status ?? null);

  protected readonly updating = computed(() => this.updatingLeadId() === this.data.leadId);

  /** Locked only for a won lead with a recorded contract (#474). */
  protected readonly locked = computed(() => {
    const lead = this.lead();
    return !!lead && lead.status === 'won' && lead.hasInvoice;
  });

  protected readonly canApply = computed(() => {
    const lead = this.lead();
    const pending = this.pending();
    return !!lead && pending !== null && pending !== lead.status && this.updatingLeadId() === null;
  });

  protected heat(lead: BuilderLeadListItem): string {
    return heatLevel(lead.leadScore, this.home.heat);
  }

  protected heatLabel(lead: BuilderLeadListItem): string {
    return heatChipLabel(lead.leadScore, this.home.heat);
  }

  protected projectType(lead: BuilderLeadListItem): string {
    return projectTypeLabel(lead.projectType, this.home.projectTypes);
  }

  protected tel(phone: string): string {
    return telHref(phone);
  }

  protected mailto(email: string): string {
    return mailtoHref(email);
  }

  protected callAria(name: string): string {
    return fill(this.home.callAria, { name });
  }

  protected emailAria(name: string): string {
    return fill(this.home.emailAria, { name });
  }

  protected statusLabel(status: BuilderLeadStatus): string {
    return this.copy.statusLabels[status];
  }

  protected statusControlLabel(name: string): string {
    return fill(this.copy.leadsStatusControlLabel, { name });
  }

  protected invoiceCtaLabel(lead: BuilderLeadListItem): string {
    const number = lead.invoiceSummary?.invoiceNumber;
    return number
      ? fill(this.copy.leadsViewInvoiceWithNumber, { number })
      : this.copy.leadsViewInvoiceCta;
  }

  protected invoiceLinkParams(lead: BuilderLeadListItem): Record<string, string> | null {
    const id = lead.invoiceSummary?.id;
    return id ? { invoice: id } : null;
  }

  protected onStatusSelect(value: string | null): void {
    this.pending.set(value as BuilderLeadStatus | null);
  }

  /** Saves the staged status; the pick clears either way so chip and select agree. */
  protected apply(): void {
    const lead = this.lead();
    const pending = this.pending();
    if (!lead || this.locked() || pending === null || pending === lead.status) {
      this.pending.set(null);
      return;
    }
    this.appliedHere.set(true);
    this.store
      .dispatch(new UpdateBuilderLeadStatus(lead.id, pending))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.pending.set(null));
  }
}
