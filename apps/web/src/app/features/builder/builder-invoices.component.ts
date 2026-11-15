import {
  Component,
  DestroyRef,
  Injector,
  OnInit,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import type { CommissionInvoiceStatus } from '@feasly/contracts';
import { Subject } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { UI_DRAWER_URL_PARAM, UiDrawerService, injectDrawerParam } from '@app/shared/ui';
import { BUILDER_COPY } from './builder-copy';
import { SeoService } from '../../core/seo/seo.service';
import { formatCentsToCad } from '../../shared/utils/money';
import { formatEdmontonMediumDate } from '../../shared/utils/edmonton';
import { BuilderBillingState } from './builder-billing.state';
import { LoadBillingCard } from './builder-billing.actions';
import type { BuilderPaymentMethod } from './builder-payment-methods';
import {
  ClearInvoiceSelection,
  ClearInvoicesState,
  LoadInvoices,
  SelectInvoice,
  SetInvoiceNumberFilter,
} from './builder-invoices.actions';
import { BuilderInvoicesState } from './builder-invoices.state';
import type { BuilderCommissionInvoice } from './builder-invoices-api.service';
import {
  BuilderInvoiceDrawerComponent,
  type BuilderInvoiceDrawerData,
} from './builder-invoice-drawer.component';
import { methodLabel, reviewCountdown } from './builder-invoice-view';

/**
 * Invoice-number search debounce (UI-responsiveness timing, not a tunable:
 * balances per-keystroke API calls against search snappiness; changes with
 * the UX, not by deploy tuning). See the hardcode allowlist.
 */
const INVOICE_NUMBER_FILTER_DEBOUNCE_MS = 400;

/** Legacy deep-link param (`?invoice=<id>`) from the money page, lead drawer and emails. */
const LEGACY_INVOICE_PARAM = 'invoice';

/**
 * Builder invoices page (BILL-04): `/builder/invoices`.
 *
 * Paginated, tenant-scoped commission invoice list (newest first). A row
 * opens the invoice drawer (#533) — kit Drawer, `?open=<id>`, so deep
 * links and Back work; a full-height sheet on phones. The legacy
 * `?invoice=<id>` deep link is rewritten to `?open=<id>` in place.
 *
 * All state lives in BuilderInvoicesState; the component dispatches and
 * renders selectors. No dispute affordance — builder disputes are deferred
 * (Karan 2026-09-27) and stay in the admin console.
 */
@Component({
  selector: 'app-builder-invoices',
  standalone: true,
  imports: [],
  templateUrl: './builder-invoices.component.html',
  styleUrls: ['./builder-invoices.component.scss'],
})
export class BuilderInvoicesComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly drawers = inject(UiDrawerService);
  private readonly injector = inject(Injector);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(BUILDER_COPY);

  protected readonly invoices = this.store.selectSignal(
    BuilderInvoicesState.invoices,
  );
  protected readonly total = this.store.selectSignal(BuilderInvoicesState.total);
  protected readonly page = this.store.selectSignal(BuilderInvoicesState.page);
  protected readonly pageSize = this.store.selectSignal(
    BuilderInvoicesState.pageSize,
  );
  protected readonly totalPages = this.store.selectSignal(
    BuilderInvoicesState.totalPages,
  );
  protected readonly listStatus = this.store.selectSignal(
    BuilderInvoicesState.listStatus,
  );
  protected readonly card = this.store.selectSignal(BuilderBillingState.card);

  /** `?open=<id>` — drives the invoice drawer (deep links, Back/Forward). */
  private readonly openId = injectDrawerParam();

  /**
   * Invoice-number search box text (what the user typed). The committed
   * server-side filter lives in the state; typing debounces into
   * {@link SetInvoiceNumberFilter} so the list searches as you type.
   */
  protected readonly filterText = signal('');

  /** Raw keystrokes → debounced filter dispatch (no leaked subscription). */
  private readonly filterInput$ = new Subject<string>();

  constructor() {
    this.seo.setPage({
      title: 'Invoices — Feasly builder portal',
      description: this.copy.invoicesSeoDescription,
      path: '/builder/invoices',
    });
    this.destroyRef.onDestroy(() => {
      this.store.dispatch(new ClearInvoicesState());
    });
    this.filterInput$
      .pipe(
        debounceTime(INVOICE_NUMBER_FILTER_DEBOUNCE_MS),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((value) => {
        this.store.dispatch(new SetInvoiceNumberFilter(value));
      });
    effect(() => {
      const id = this.openId();
      if (id) untracked(() => this.openDrawer(id));
    });
  }

  ngOnInit(): void {
    this.store.dispatch(new LoadInvoices(1));
    // Card summary for method labels and paid-invoice receipts (last4).
    this.store.dispatch(new LoadBillingCard());
    // Legacy deep link (?invoice=<id>, from the money page, lead drawer and
    // record-contract card): rewrite to the drawer's ?open=<id> in place.
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const invoiceId = params.get(LEGACY_INVOICE_PARAM);
        if (invoiceId) {
          void this.router.navigate([], {
            relativeTo: this.route,
            queryParams: { [LEGACY_INVOICE_PARAM]: null, [UI_DRAWER_URL_PARAM]: invoiceId },
            queryParamsHandling: 'merge',
            replaceUrl: true,
          });
        }
      });
  }

  protected retryLoad(): void {
    this.store.dispatch(new LoadInvoices(this.page()));
  }

  /** Keystroke in the invoice-number search box — debounced into the state. */
  protected onFilterInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.filterText.set(value);
    this.filterInput$.next(value);
  }

  /** Clears the invoice-number search and reloads the full list. */
  protected clearFilter(): void {
    this.filterText.set('');
    this.store.dispatch(new SetInvoiceNumberFilter(''));
  }

  /** Row → the invoice drawer; the drawer service pushes `?open=<id>` (Back closes it). */
  protected openInvoice(id: string): void {
    this.openDrawer(id);
  }

  private openDrawer(id: string): void {
    const current = this.drawers.openDrawer;
    if (current && !current.finished && current.urlId === id) return;
    this.store.dispatch(new SelectInvoice(id));
    const ref = this.drawers.open<BuilderInvoiceDrawerComponent, unknown, BuilderInvoiceDrawerData>(
      BuilderInvoiceDrawerComponent,
      { data: { invoiceId: id }, size: 'md', urlId: id, injector: this.injector },
    );
    ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.store.selectSnapshot(BuilderInvoicesState.selected)?.id === id) {
        this.store.dispatch(new ClearInvoiceSelection());
      }
    });
  }

  protected prevPage(): void {
    this.store.dispatch(new LoadInvoices(this.page() - 1));
  }

  protected nextPage(): void {
    this.store.dispatch(new LoadInvoices(this.page() + 1));
  }

  protected pageLabel(): string {
    const totalPages = this.totalPages();
    if (totalPages === null) {
      // Backend reports no total (bare-array pagination): "Page N".
      return this.copy.invoicesPage.replace('{page}', String(this.page()));
    }
    return this.copy.invoicesPageOf
      .replace('{page}', String(this.page()))
      .replace('{pages}', String(totalPages));
  }

  /**
   * Whether the Next button should be disabled. With a known total this is
   * the last numbered page; with an unknown total (bare-array backend) the
   * page is last when it came back shorter than a full page.
   */
  protected isLastPage(): boolean {
    const totalPages = this.totalPages();
    if (totalPages !== null) {
      return this.page() >= totalPages;
    }
    return this.invoices().length < this.pageSize();
  }

  /** Integer cents → "$12,345" (shared money util, integer math only). */
  protected money(cents: number): string {
    return formatCentsToCad(cents);
  }

  /** ISO instant → America/Edmonton medium date (the billing calendar). */
  protected formatEdmontonDate(iso: string | null): string {
    return formatEdmontonMediumDate(iso);
  }

  protected statusLabel(status: CommissionInvoiceStatus): string {
    switch (status) {
      case 'draft':
        return this.copy.invoiceStatusDraft;
      case 'in_review':
        return this.copy.invoiceStatusInReview;
      case 'finalized':
        return this.copy.invoiceStatusFinalized;
      case 'paid':
        return this.copy.invoiceStatusPaid;
      case 'failed':
        return this.copy.invoiceStatusFailed;
      case 'disputed':
        return this.copy.invoiceStatusDisputed;
      case 'void':
        return this.copy.invoiceStatusVoid;
    }
  }

  /** Method-aware review countdown ("Auto-charges in 3 days" / "Due in 3 days"). */
  protected reviewCountdown(invoice: BuilderCommissionInvoice): string | null {
    return reviewCountdown(invoice, this.copy);
  }

  /** Buyer-grade label, e.g. "Card •••• 4242" or "Cheque". */
  protected methodLabel(method: BuilderPaymentMethod): string {
    return methodLabel(method, this.copy, this.card()?.last4);
  }
}
