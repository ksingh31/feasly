import { Component, DestroyRef, Injector, OnInit, computed, effect, inject, untracked } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, type Params, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import type { DisputeListItem } from '@feasly/contracts';
import {
  DataTableComponent,
  type DataTableColumn,
  EntityLinkComponent,
  PageHeaderComponent,
  StatusChipComponent,
  UiButtonComponent,
  UiCellDirective,
  type UiDrawerRef,
  UiDrawerService,
} from '@app/shared/ui';
import { openAdminEntity } from './admin-entity-routes';
import {
  type DisputeSlaChip,
  disputeAmountCents,
  disputeReasonLabel,
  disputeSlaChip,
  isChargeback,
} from './admin-disputes-view';
import { ClearSelectedAdminDispute, LoadAdminDisputes, SelectAdminDispute } from './admin-disputes.actions';
import { AdminDisputesState } from './admin-disputes.state';
import { AdminDisputeDrawerComponent, type AdminDisputeDrawerData } from './admin-dispute-drawer.component';
import { injectAdminCopy } from './admin-copy';

/** Query param holding the open dispute (portal-ui-kit §3: `?open=<id>`). */
const OPEN_PARAM = 'open';

/**
 * Admin Disputes (#545, admin review S12) — Karan's queue for builder
 * invoice disputes, oldest first (server order). #872: Stripe bank
 * chargebacks share the queue, marked with a "Chargeback" chip next to
 * the builder (table and phone card), their disputed amount, Stripe
 * reason and an evidence-deadline countdown.
 *
 * A kit DataTable (Opened · Invoice · Builder · Amount · Reason · SLA) —
 * the SLA chip reads "4 days left" (neutral), "Due today" (warning) or
 * "Overdue 1d" (danger) from the server's business-day countdown on the
 * America/Edmonton calendar. Breached rows are flagged. Clicking a row
 * opens the dispute drawer (`?open=<id>`): evidence snapshot, humanised
 * audit timeline, and Note + [Reject] [Accept…] through ConfirmDialog.
 *
 * An SLA breach escalates via ops alerts and NEVER auto-resolves.
 * Guarded by `adminGuard`; noindex; lazy-loaded. All state lives in
 * `AdminDisputesState` — the page only dispatches actions and reads signals.
 */
@Component({
  selector: 'app-admin-disputes',
  standalone: true,
  imports: [
    PageHeaderComponent,
    DataTableComponent,
    UiCellDirective,
    StatusChipComponent,
    EntityLinkComponent,
    UiButtonComponent,
  ],
  templateUrl: './admin-disputes.component.html',
  styleUrls: ['./admin-disputes.component.scss'],
})
export class AdminDisputesComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly drawers = inject(UiDrawerService);

  /** EntityLink copy (#538): the invoice cell never shows a raw UUID. */
  protected readonly entityCopy = injectAdminCopy().entities;

  protected readonly disputes = this.store.selectSignal(AdminDisputesState.disputes);
  protected readonly listStatus = this.store.selectSignal(AdminDisputesState.listStatus);
  protected readonly listError = this.store.selectSignal(AdminDisputesState.listError);

  protected readonly countLabel = computed(() => {
    const n = this.disputes().length;
    return n === 1 ? '1 open dispute' : `${n} open disputes`;
  });

  protected readonly rowId = (d: DisputeListItem): string => d.id;
  protected readonly isBreached = (d: DisputeListItem): boolean => d.breached;

  protected readonly columns: readonly DataTableColumn<DisputeListItem>[] = [
    { key: 'openedAt', header: 'Opened', kind: 'date', cardRole: 'meta' },
    { key: 'invoice', header: 'Invoice', cardRole: 'meta', value: () => this.entityCopy.viewInvoice },
    { key: 'builder', header: 'Builder', cardRole: 'title', value: (d) => d.tenantKey },
    // #872: a chargeback shows the disputed charge and Stripe's reason code.
    { key: 'amount', header: 'Amount', kind: 'money', cardRole: 'meta', value: (d) => disputeAmountCents(d) },
    { key: 'reason', header: 'Reason', kind: 'text', cardRole: 'hidden', value: (d) => disputeReasonLabel(d) },
    { key: 'sla', header: 'Due', cardRole: 'chip', value: (d) => disputeSlaChip(d).label },
  ];

  private readonly queryParams = toSignal(this.route.queryParams, {
    initialValue: this.route.snapshot.queryParams as Params,
  });

  protected readonly openId = computed(() => {
    const raw = this.queryParams()[OPEN_PARAM];
    return typeof raw === 'string' && raw ? raw : null;
  });

  private drawerRef: UiDrawerRef<unknown, AdminDisputeDrawerComponent> | null = null;

  constructor() {
    // `?open=<id>` drives the drawer for deep links and Back/Forward. The
    // drawer loads the detail itself, so it needn't wait for the list.
    effect(() => {
      const id = this.openId();
      if (id) untracked(() => this.openDrawer(id));
    });
    this.destroyRef.onDestroy(() => this.store.dispatch(new ClearSelectedAdminDispute()));
  }

  ngOnInit(): void {
    this.reload();
  }

  protected reload(): void {
    this.store.dispatch(new LoadAdminDisputes()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      error: () => undefined,
    });
  }

  protected chargeback(d: DisputeListItem): boolean {
    return isChargeback(d);
  }

  protected sla(d: DisputeListItem): DisputeSlaChip {
    return disputeSlaChip(d);
  }

  protected openDispute(d: DisputeListItem): void {
    this.openDrawer(d.id);
  }

  protected openInvoice(invoiceId: string): void {
    openAdminEntity(this.router, 'invoice', invoiceId);
  }

  private openDrawer(id: string): void {
    const ref = this.drawers.open<AdminDisputeDrawerComponent, unknown, AdminDisputeDrawerData>(
      AdminDisputeDrawerComponent,
      {
        data: { disputeId: id },
        size: 'lg',
        urlId: id,
        injector: this.injector,
        discardConfirm: {
          title: 'Discard your note?',
          body: 'The note hasn’t been sent with a decision yet.',
          verb: 'Discard',
          cancelLabel: 'Keep editing',
        },
      },
    );
    if (ref === this.drawerRef) return;
    this.drawerRef = ref;
    this.store.dispatch(new SelectAdminDispute(id));
    ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.drawerRef !== ref) return;
      this.drawerRef = null;
      this.store.dispatch(new ClearSelectedAdminDispute());
    });
  }
}
