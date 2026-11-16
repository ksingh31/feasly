import { DIALOG_DATA } from '@angular/cdk/dialog';
import {
  Component,
  DestroyRef,
  EnvironmentInjector,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { BuilderLeadListItem, BuilderLeadStatus } from '@feasly/contracts';
import {
  KitDatePipe,
  StatusChipComponent,
  StepperComponent,
  TimelineComponent,
  type TimelineEvent,
  UiButtonComponent,
  UiDrawerComponent,
  UiSelectComponent,
  type UiSelectOption,
  UiToastService,
  leadStepperModel,
} from '@app/shared/ui';
import { formatEdmontonDateTime, formatEdmontonMediumDate } from '../../shared/utils/edmonton';
import { formatCallbackDay } from '../../shared/utils/callback-day';
import { ConfigService } from '../../core/config/config.service';
import { BUILDER_COPY } from './builder-copy';
import { BuilderLeadCommentsComponent } from './builder-lead-comments.component';
import { BuilderRecordContractPanelComponent } from './builder-record-contract-panel.component';
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

export interface BuilderLeadDrawerData {
  readonly leadId: string;
}

/**
 * Builder lead drawer (#528, artboard "Builder · Lead drawer"), opened
 * from the Leads home with the kit Drawer (`?open=<id>`; full-height sheet
 * on phones). Replaces the #527 quick-view modal.
 *
 * - Contact actions (tap-to-call / email).
 * - Status stepper with one-tap "move to" buttons. Lead status is not a
 *   money change, so it applies immediately and a toast offers Undo
 *   (portal-ui-kit §5). Won → record the contract inline (#529: value,
 *   date, live commission, confirm, success); Lost → optional
 *   reason, saved to the notes thread.
 * - Details, an activity timeline from the fields the lead already carries,
 *   and the notes thread with its composer pinned in the drawer footer.
 *
 * Reads the lead live from BuilderState so a confirmed change (or an
 * Undo) re-renders in place. No business rules here: the #474 lock reads
 * server fields, and every write goes through UpdateBuilderLeadStatus.
 */
@Component({
  selector: 'app-builder-lead-drawer',
  standalone: true,
  imports: [
    RouterLink,
    UiDrawerComponent,
    UiButtonComponent,
    UiSelectComponent,
    StatusChipComponent,
    StepperComponent,
    TimelineComponent,
    KitDatePipe,
    BuilderLeadCommentsComponent,
    BuilderRecordContractPanelComponent,
  ],
  templateUrl: './builder-lead-drawer.component.html',
  styleUrl: './builder-lead-drawer.component.scss',
})
export class BuilderLeadDrawerComponent {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  /** Outlives the drawer (the Undo toast can be pressed after it closes). */
  private readonly portalDestroyRef = inject(EnvironmentInjector).get(DestroyRef);
  private readonly toasts = inject(UiToastService);
  private readonly data = inject<BuilderLeadDrawerData>(DIALOG_DATA);

  protected readonly copy = inject(BUILDER_COPY);
  protected readonly home = this.copy.leadsHome;
  protected readonly t = this.copy.leadDrawer;
  protected readonly statuses = PIPELINE_STATUSES;
  protected readonly lostReasonOptions: readonly UiSelectOption[] = this.t.lostReasons.map((reason) => ({
    value: reason,
    label: reason,
  }));

  private readonly notes = viewChild(BuilderLeadCommentsComponent);

  private readonly leads = this.store.selectSignal(BuilderState.leads);
  private readonly updatingLeadId = this.store.selectSignal(BuilderState.updatingLeadId);
  private readonly storeUpdateError = this.store.selectSignal(BuilderState.updateError);
  protected readonly isAdmin = this.store.selectSignal(BuilderState.isBuilderAdmin);

  /** True once this drawer changed the status — scopes the global updateError to it. */
  private readonly changedHere = signal(false);
  protected readonly updateError = computed(() => (this.changedHere() ? this.storeUpdateError() : null));

  protected readonly lead = computed<BuilderLeadListItem | null>(
    () => this.leads().find((l) => l.id === this.data.leadId) ?? null,
  );

  protected readonly updating = computed(() => this.updatingLeadId() === this.data.leadId);
  /** Any lead write in flight (the store tracks one at a time). */
  protected readonly busy = computed(() => this.updatingLeadId() !== null);

  /** Locked only for a won lead with a recorded contract (#474). */
  protected readonly locked = computed(() => {
    const lead = this.lead();
    return !!lead && lead.status === 'won' && lead.hasInvoice;
  });

  protected readonly stepper = computed(() => leadStepperModel(this.lead()?.status));

  private readonly callbackWindows = inject(ConfigService).get('copy').report.callbackWindows;

  /** #836: the newest callback request, display-ready (null when none). */
  protected readonly callback = computed(() => {
    const request = this.lead()?.latestCallback;
    if (!request) return null;
    const w = this.callbackWindows.find((option) => option.id === request.window);
    return {
      day: formatCallbackDay(request.preferredDate) ?? this.t.callbackAnyDay,
      window: w ? `${w.label} (${w.range})` : request.window,
      notes: request.notes,
      requested: formatEdmontonDateTime(request.createdAt),
    };
  });

  /** A contract recorded from this drawer: keep its success state on screen. */
  protected readonly recordedHere = signal(false);

  /** Lost-reason panel: picked reason (unsaved) and whether one was saved here. */
  protected readonly lostReason = signal<string | null>(null);
  protected readonly lostReasonSaved = signal(false);
  protected readonly savingReason = signal(false);

  /** Pinned composer draft. */
  protected readonly draft = signal('');
  protected readonly posting = signal(false);
  protected readonly canPost = computed(() => {
    const body = this.draft().trim();
    return body.length > 0 && body.length <= this.copy.commentsMaxLength && !this.posting();
  });

  /** Unsaved note or lost reason → Esc / × / scrim / Back ask first. */
  protected readonly dirty = computed(
    () => this.draft().trim().length > 0 || (this.lostReason() !== null && !this.lostReasonSaved()),
  );

  protected readonly activity = computed<TimelineEvent[]>(() => {
    const lead = this.lead();
    if (!lead) return [];
    const events: TimelineEvent[] = [
      { id: 'arrived', at: lead.createdAt, title: this.t.activityArrived, tone: 'info' },
    ];
    // The list carries the latest status change only; the full history is
    // server-side (follow-up). A lead still at `new` has no change to show.
    if (lead.status !== 'new') {
      events.push({
        id: 'status',
        at: lead.statusUpdatedAt,
        title: fill(this.t.activityStatus, { status: this.statusLabel(lead.status) }),
      });
    }
    return events;
  });

  constructor() {
    // A fresh move to Lost re-asks for the reason.
    effect(() => {
      if (this.lead()?.status !== 'lost') {
        this.lostReason.set(null);
        this.lostReasonSaved.set(false);
      }
    });
  }

  protected arrivedMeta(lead: BuilderLeadListItem): string {
    return fill(this.t.arrivedMeta, { date: formatEdmontonMediumDate(lead.createdAt) });
  }

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

  protected moveToLabel(name: string): string {
    return fill(this.t.moveToLabel, { name });
  }

  protected statusLabel(status: BuilderLeadStatus): string {
    return this.copy.statusLabels[status];
  }

  protected invoiceCtaLabel(lead: BuilderLeadListItem): string {
    const number = lead.invoiceSummary?.invoiceNumber;
    return number ? fill(this.copy.leadsViewInvoiceWithNumber, { number }) : this.copy.leadsViewInvoiceCta;
  }

  protected invoiceLinkParams(lead: BuilderLeadListItem): Record<string, string> | null {
    const id = lead.invoiceSummary?.id;
    return id ? { invoice: id } : null;
  }

  /**
   * Applies the status immediately; on success a toast offers Undo, which
   * moves the lead back to the status it had. Failures stay inline.
   */
  protected moveTo(status: BuilderLeadStatus): void {
    const lead = this.lead();
    if (!lead || this.locked() || this.busy() || status === lead.status) return;
    const previous = lead.status;
    const leadId = lead.id;
    this.changedHere.set(true);
    this.store
      .dispatch(new UpdateBuilderLeadStatus(leadId, status))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.store.selectSnapshot(BuilderState.updateError) !== null) return;
        this.toasts.show({
          message: fill(this.t.statusChangedToast, { status: this.statusLabel(status) }),
          undoLabel: this.t.undoLabel,
          undo: () => this.undo(leadId, previous),
        });
      });
  }

  /**
   * Undo from the toast. The toast can outlive the drawer, so the write is
   * tied to the portal's lifetime, not the drawer's.
   */
  private undo(leadId: string, previous: BuilderLeadStatus): void {
    const store = this.store;
    const toasts = this.toasts;
    const message = fill(this.t.statusRevertedToast, { status: this.statusLabel(previous) });
    store
      .dispatch(new UpdateBuilderLeadStatus(leadId, previous))
      .pipe(takeUntilDestroyed(this.portalDestroyRef))
      .subscribe(() => {
        if (store.selectSnapshot(BuilderState.updateError) === null) {
          toasts.show({ message, tone: 'info' });
        }
      });
  }

  protected onLostReason(value: string | null): void {
    this.lostReason.set(value);
    this.lostReasonSaved.set(false);
  }

  protected saveLostReason(): void {
    const reason = this.lostReason();
    const notes = this.notes();
    if (!reason || !notes || this.savingReason()) return;
    this.savingReason.set(true);
    notes
      .addNote(fill(this.t.lostReasonNote, { reason }))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ok) => {
        this.savingReason.set(false);
        this.lostReasonSaved.set(ok);
      });
  }

  protected onDraft(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  protected postNote(): void {
    const notes = this.notes();
    if (!notes || !this.canPost()) return;
    this.posting.set(true);
    notes
      .addNote(this.draft().trim())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ok) => {
        this.posting.set(false);
        if (ok) this.draft.set('');
      });
  }

  /** Ctrl/⌘+Enter posts from the composer. */
  protected onComposerKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.postNote();
    }
  }
}
