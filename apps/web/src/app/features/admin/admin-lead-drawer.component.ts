import { DIALOG_DATA } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { type Observable, concat, defer, filter } from 'rxjs';
import type { AdminLeadDetail, AdminLeadReassignmentEntry, AdminLeadStatus } from '@feasly/contracts';
import { ConfigService } from '@app/core/config/config.service';
import {
  KeyValueListComponent,
  type KeyValueItem,
  KitDateTimePipe,
  StatusChipComponent,
  UiButtonComponent,
  UiConfirmService,
  UiDrawerComponent,
  UiDrawerRef,
  UiSelectComponent,
  type UiSelectOption,
  UiToastService,
  enumLabel,
  statusPresentation,
} from '@app/shared/ui';
import { formatCentsRangeToCad, formatCentsToCad } from '@app/shared/utils/money';
import { formatEdmontonDateTime } from '@app/shared/utils/edmonton';
import { formatCallbackDay } from '@app/shared/utils/callback-day';
import {
  AddAdminLeadNote,
  ClearSelectedAdminLead,
  DismissAdminLeadNoteError,
  DismissAdminLeadStatusError,
  DismissAdminLeadStatusSuccess,
  SelectAdminLead,
  UpdateAdminLeadStatus,
} from './admin-leads.actions';
import { AdminLeadsState } from './admin-leads.state';
import {
  AssignLeadBuilder,
  DismissAssignBuilderError,
  DismissAssignBuilderSuccess,
  LoadBuilders,
} from './admin-builders.actions';
import { AdminBuildersState } from './admin-builders.state';
import { AdminLeadCommentsComponent } from './admin-lead-comments.component';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';
import { PIPELINE_STATUSES, UNASSIGNED, fill } from './admin-leads-view';

/** Drawer input: the lead to show (mirrored in the URL as `?open=<id>`). */
export interface AdminLeadDrawerData {
  readonly id: string;
}

/**
 * Admin lead drawer (#539, admin review S6). Opened by the Leads page via
 * `UiDrawerService` with `urlId`, so `?open=<id>` deep-links and Back closes.
 *
 * Sections, in order: Pipeline → Contact → Property & estimate (links to the
 * estimate) → Invoices (link) → Notes → Comments → Activity → Record.
 *
 * Pipeline is one small form — Status + Assigned builder — committed by the
 * single sticky-footer Save, which enables only when something changed.
 * Unsaved picks arm the drawer's discard guard. Enum values go through the
 * kit label dictionary; they never render raw.
 *
 * All data lives in AdminLeadsState / AdminBuildersState — the component
 * dispatches and reads signals.
 */
@Component({
  selector: 'app-admin-lead-drawer',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    UiDrawerComponent,
    UiButtonComponent,
    UiSelectComponent,
    StatusChipComponent,
    KeyValueListComponent,
    KitDateTimePipe,
    AdminLeadCommentsComponent,
  ],
  templateUrl: './admin-lead-drawer.component.html',
  styleUrl: './admin-lead-drawer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminLeadDrawerComponent {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toasts = inject(UiToastService);
  private readonly confirms = inject(UiConfirmService);
  private readonly data = inject<AdminLeadDrawerData>(DIALOG_DATA);
  protected readonly ref = inject(UiDrawerRef);

  protected readonly pageCopy = inject(ConfigService).get('copy').admin.leads;
  protected readonly copy = this.pageCopy.drawer;
  private readonly callbackWindows = inject(ConfigService).get('copy').report.callbackWindows;

  protected readonly detail = this.store.selectSignal(AdminLeadsState.detail);
  protected readonly detailStatus = this.store.selectSignal(AdminLeadsState.detailStatus);
  protected readonly detailError = this.store.selectSignal(AdminLeadsState.detailError);
  protected readonly detailRefreshError = this.store.selectSignal(AdminLeadsState.detailRefreshError);
  protected readonly notePosting = this.store.selectSignal(AdminLeadsState.notePosting);
  protected readonly noteError = this.store.selectSignal(AdminLeadsState.noteError);
  protected readonly statusUpdateError = this.store.selectSignal(AdminLeadsState.statusUpdateError);
  protected readonly builders = this.store.selectSignal(AdminBuildersState.builders);
  protected readonly buildersStatus = this.store.selectSignal(AdminBuildersState.listStatus);
  protected readonly assignError = this.store.selectSignal(AdminBuildersState.assignError);

  /** Display gating only — the backend 403s without the permission. */
  protected readonly canManageLeads = adminCan(this.store, ADMIN_PERMISSIONS.leadsManage);
  protected readonly canAssignLeads = adminCan(this.store, ADMIN_PERMISSIONS.leadsAssign);
  protected readonly canEdit = computed(() => this.canManageLeads() || this.canAssignLeads());

  /** The detail for *this* drawer's lead (never another lead's stale detail). */
  protected readonly lead = computed<AdminLeadDetail | null>(() => {
    const detail = this.detail();
    return detail && detail.id === this.data.id ? detail : null;
  });

  /** Pending pipeline picks (committed by Save). Builder null = unassigned. */
  protected readonly statusPick = signal<AdminLeadStatus | null>(null);
  protected readonly builderPick = signal<string | null>(null);
  protected readonly saving = signal(false);

  protected readonly statusOptions: readonly UiSelectOption[] = PIPELINE_STATUSES.map((status) => ({
    value: status,
    label: statusPresentation('lead', status).label,
  }));

  protected readonly builderOptions = computed<readonly UiSelectOption[]>(() =>
    this.builders().map((b) => ({ value: b.id, label: b.displayName })),
  );

  protected readonly statusChanged = computed(() => {
    const lead = this.lead();
    const pick = this.statusPick();
    return this.canManageLeads() && lead !== null && pick !== null && pick !== lead.status;
  });

  protected readonly builderChanged = computed(() => {
    const lead = this.lead();
    return this.canAssignLeads() && lead !== null && this.builderPick() !== (lead.builderId ?? null);
  });

  protected readonly dirty = computed(() => this.statusChanged() || this.builderChanged());

  /**
   * #721/#803: builder moves of this lead, newest first, with builder ids
   * resolved to display names (null = unassigned).
   */
  protected readonly reassignments = computed(() => {
    const entries: readonly AdminLeadReassignmentEntry[] = this.lead()?.reassignments ?? [];
    return [...entries].reverse().map((entry) => ({
      key: `${entry.changedAt}|${entry.fromBuilderId ?? ''}|${entry.toBuilderId ?? ''}`,
      from: this.builderName(entry.fromBuilderId),
      to: this.builderName(entry.toBuilderId),
      changedBy: entry.changedBy,
      changedAt: entry.changedAt,
    }));
  });

  protected readonly noteControl = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(5000)],
  });

  protected readonly contactItems = computed<readonly KeyValueItem[]>(() => {
    const lead = this.lead();
    if (!lead) return [];
    const l = this.copy.labels;
    return [
      { label: l.email, value: lead.email, href: `mailto:${lead.email}` },
      { label: l.phone, value: lead.phone, href: lead.phone ? `tel:${lead.phone}` : undefined },
      { label: l.source, value: enumLabel(lead.source) },
      { label: l.tenant, value: lead.tenantKey },
      { label: l.magicLink, value: this.copy.magicLink[lead.magicLinkStatus] ?? this.copy.magicLink.none },
      { label: l.contactConsent, value: lead.contactConsent === 'in' ? this.copy.yes : this.copy.no },
      { label: l.marketingConsent, value: lead.marketingConsent ? this.copy.yes : this.copy.no },
    ];
  });

  /**
   * #815: campaign attribution captured with the lead submit (leads.source_*).
   * Only the set fields are listed; empty = render the no-attribution note.
   */
  protected readonly attributionItems = computed<readonly KeyValueItem[]>(() => {
    const source = this.lead()?.attribution;
    if (!source) return [];
    const l = this.copy.labels;
    const rows: KeyValueItem[] = [
      { label: l.utmSource, value: source.utm_source ?? null },
      { label: l.utmMedium, value: source.utm_medium ?? null },
      { label: l.utmCampaign, value: source.utm_campaign ?? null },
      { label: l.utmTerm, value: source.utm_term ?? null },
      { label: l.utmContent, value: source.utm_content ?? null },
      { label: l.clickIdType, value: source.click_id_type ?? null },
    ];
    return rows.filter((row) => row.value !== null);
  });

  /** #836: callback requests (newest first), each as a key/value block. */
  protected readonly callbackRequests = computed(() => {
    const requests = this.lead()?.callbacks ?? [];
    const l = this.copy.callbackLabels;
    return requests.map((request) => {
      const w = this.callbackWindows.find((option) => option.id === request.window);
      const items: KeyValueItem[] = [
        { label: l.day, value: formatCallbackDay(request.preferredDate) ?? this.copy.callbackAnyDay },
        { label: l.window, value: w ? `${w.label} (${w.range})` : request.window },
        { label: l.phone, value: request.phone, href: `tel:${request.phone}` },
        { label: l.notes, value: request.notes },
        { label: l.requested, value: formatEdmontonDateTime(request.createdAt) },
      ];
      return { id: request.id, items: items.filter((item) => item.value !== null) };
    });
  });

  protected readonly propertyItems = computed<readonly KeyValueItem[]>(() => {
    const estimate = this.lead()?.estimate;
    if (!estimate) return [];
    const l = this.copy.labels;
    return [
      { label: l.address, value: estimate.addressKey },
      { label: l.projectType, value: enumLabel(estimate.projectType) },
      {
        label: l.livingArea,
        value: estimate.sqft !== null ? fill(this.copy.sqftValue, { sqft: estimate.sqft }) : null,
      },
      { label: l.finishTier, value: estimate.tier ? enumLabel(estimate.tier) : null },
      { label: l.totalRange, value: formatCentsRangeToCad(estimate.totalRangeCents) },
      { label: l.buildRange, value: formatCentsRangeToCad(estimate.buildRangeCents) },
      { label: l.land, value: formatCentsToCad(estimate.landCents) },
      { label: l.estimated, value: formatEdmontonDateTime(estimate.createdAt) },
    ];
  });

  protected readonly recordItems = computed<readonly KeyValueItem[]>(() => {
    const lead = this.lead();
    if (!lead) return [];
    const l = this.copy.labels;
    const when = (iso: string | null): string | null => (iso ? formatEdmontonDateTime(iso) : null);
    return [
      { label: l.leadScore, value: lead.leadScore },
      { label: l.consented, value: when(lead.consentTs) },
      { label: l.sheetsSynced, value: when(lead.sheetsSyncedAt) },
      { label: l.snapshots, value: lead.snapshotCount },
      { label: l.unsubscribed, value: when(lead.unsubscribedAt) },
      { label: l.nudgeSent, value: when(lead.nudgeSentAt) },
    ];
  });

  /** Last server values the picks were synced from (re-sync only when they change). */
  private synced: { id: string; status: AdminLeadStatus; builderId: string | null } | null = null;

  constructor() {
    this.store.dispatch(new SelectAdminLead(this.data.id));
    // Fresh builders each open — names can change under us.
    this.store.dispatch(new LoadBuilders());

    // Seed the picks from the server values. A refresh that leaves them
    // unchanged (e.g. after adding a note) keeps any unsaved picks.
    effect(() => {
      const lead = this.lead();
      if (!lead) return;
      const next = { id: lead.id, status: lead.status, builderId: lead.builderId ?? null };
      const prev = this.synced;
      if (prev && prev.id === next.id && prev.status === next.status && prev.builderId === next.builderId) {
        return;
      }
      this.synced = next;
      untracked(() => {
        this.statusPick.set(next.status);
        this.builderPick.set(next.builderId);
      });
    });

    // Typing a new note clears the previous note error.
    this.noteControl.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      if (this.noteError()) this.store.dispatch(new DismissAdminLeadNoteError());
    });

    this.destroyRef.onDestroy(() => this.store.dispatch(new ClearSelectedAdminLead()));
  }

  protected onStatusPick(value: string | null): void {
    this.statusPick.set((value as AdminLeadStatus | null) ?? this.lead()?.status ?? null);
    this.clearPipelineFeedback();
  }

  protected onBuilderPick(value: string | null): void {
    this.builderPick.set(value && value !== UNASSIGNED ? value : null);
    this.clearPipelineFeedback();
  }

  /**
   * The one Save: commits the changed pipeline fields — status first, then
   * the builder — and stops at the first failure (its error shows inline).
   */
  protected save(): void {
    const lead = this.lead();
    if (!lead || !this.dirty() || this.saving()) return;
    // Moving a lead away from a builder closes that builder's attribution
    // (#721) — confirm the consequences first. A first assignment doesn't.
    if (this.builderChanged() && lead.builderId) {
      const c = this.copy.reassignConfirm;
      const values = {
        lead: lead.name,
        from: this.builderName(lead.builderId),
        to: this.builderName(this.builderPick()),
      };
      const unassign = this.builderPick() === null;
      this.confirms
        .confirm({
          title: fill(unassign ? c.unassignTitle : c.title, values),
          body: fill(unassign ? c.unassignBody : c.body, values),
          verb: unassign ? c.unassignVerb : c.verb,
          cancelLabel: c.cancel,
          tone: 'danger',
        })
        .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
        .subscribe(() => this.commit());
      return;
    }
    this.commit();
  }

  private commit(): void {
    const lead = this.lead();
    if (!lead || !this.dirty() || this.saving()) return;
    const id = lead.id;
    const status = this.statusPick();
    const builderId = this.builderPick();
    const steps: Observable<unknown>[] = [];
    if (this.statusChanged() && status) {
      steps.push(defer(() => this.store.dispatch(new UpdateAdminLeadStatus(id, status))));
    }
    if (this.builderChanged()) {
      steps.push(defer(() => this.store.dispatch(new AssignLeadBuilder(id, builderId))));
    }
    this.clearPipelineFeedback();
    this.saving.set(true);
    concat(...steps)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        complete: () => {
          this.saving.set(false);
          this.store.dispatch([new DismissAdminLeadStatusSuccess(), new DismissAssignBuilderSuccess()]);
          // Refetch so the drawer shows the stored assignment + fresh history.
          this.store.dispatch(new SelectAdminLead(id));
          this.toasts.show({ message: this.copy.saved });
        },
        error: () => {
          this.saving.set(false);
          // A failed status write rolls itself back (and a refetch would
          // clear its inline error). A failed assign re-reads the server
          // state; its error lives in AdminBuildersState and survives.
          if (!this.statusUpdateError()) this.store.dispatch(new SelectAdminLead(id));
        },
      });
  }

  protected addNote(): void {
    const lead = this.lead();
    const note = this.noteControl.value.trim();
    if (!lead || note.length === 0 || this.notePosting()) return;
    this.store
      .dispatch(new AddAdminLeadNote(lead.id, note))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: () => this.noteControl.reset() });
  }

  protected retry(): void {
    this.store.dispatch(new SelectAdminLead(this.data.id));
  }

  protected statusLabel(status: AdminLeadStatus | null): string {
    return status ? statusPresentation('lead', status).label : '—';
  }

  /** Builder display name for an id; null reads as "Unassigned". */
  protected builderName(id: string | null): string {
    if (id === null) return this.copy.unassigned;
    return this.builders().find((b) => b.id === id)?.displayName ?? this.copy.unknownBuilder;
  }

  private clearPipelineFeedback(): void {
    if (this.statusUpdateError()) this.store.dispatch(new DismissAdminLeadStatusError());
    if (this.assignError()) this.store.dispatch(new DismissAssignBuilderError());
  }
}
