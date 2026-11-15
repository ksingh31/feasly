import { Component, DestroyRef, Injector, OnInit, effect, inject, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Store } from '@ngxs/store';
import {
  DataTableComponent,
  type DataTableColumn,
  PageHeaderComponent,
  UiDrawerService,
  injectDrawerParam,
} from '@app/shared/ui';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { ConfigService } from '../../core/config/config.service';
import {
  ADMIN_INVOICE_STATUS_OPTIONS,
  DismissAdminInvoiceListError,
  LoadAdminInvoices,
  SetAdminInvoiceFilters,
} from './admin-invoices.actions';
import type { AdminInvoiceFilters } from './admin-invoices.actions';
import { AdminInvoicesState } from './admin-invoices.state';
import type { BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';
import { AdminInvoiceDrawerComponent, type AdminInvoiceDrawerData } from './admin-invoice-drawer.component';

/**
 * Admin invoice list (QA admin-console fix 3; kit table + drawer #543):
 * every commission invoice across tenants, newest first, with a status
 * filter, an invoice-number search, and pagination. A row opens the
 * invoice drawer (`?open=<id>`, so Back closes it and deep links work) —
 * the hub for amounts, activity and the intent-specific actions.
 *
 * Route: `/admin/billing/invoices`, inside the admin shell.
 * (`/admin/billing/invoices/:id` redirects here with `?open=:id`.)
 */
@Component({
  selector: 'app-admin-invoices',
  standalone: true,
  imports: [ReactiveFormsModule, PageHeaderComponent, DataTableComponent],
  templateUrl: './admin-invoices.component.html',
  styleUrl: './admin-invoices.component.scss',
})
export class AdminInvoicesComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly drawers = inject(UiDrawerService);

  /** `?open=<id>` — the invoice whose drawer is open. */
  protected readonly openId = injectDrawerParam();

  protected readonly rowId = (invoice: BuilderCommissionInvoice): string => invoice.id;

  protected readonly columns: readonly DataTableColumn<BuilderCommissionInvoice>[] = [
    { key: 'invoiceNumber', header: 'Invoice', kind: 'id', cardRole: 'title' },
    { key: 'status', header: 'Status', kind: 'status', statusDomain: 'invoice', cardRole: 'chip' },
    { key: 'tenantKey', header: 'Builder', cardRole: 'meta' },
    { key: 'leadName', header: 'Lead', cardRole: 'meta' },
    { key: 'commissionCents', header: 'Commission', kind: 'money', cardRole: 'meta' },
    { key: 'createdAt', header: 'Created', kind: 'date', cardRole: 'hidden' },
  ];

  protected readonly invoices = this.store.selectSignal(AdminInvoicesState.invoices);
  protected readonly total = this.store.selectSignal(AdminInvoicesState.total);
  protected readonly page = this.store.selectSignal(AdminInvoicesState.page);
  protected readonly pageSize = this.store.selectSignal(AdminInvoicesState.pageSize);
  protected readonly filters = this.store.selectSignal(AdminInvoicesState.filters);
  protected readonly listStatus = this.store.selectSignal(AdminInvoicesState.listStatus);
  protected readonly listError = this.store.selectSignal(AdminInvoicesState.listError);

  protected readonly statusOptions = ADMIN_INVOICE_STATUS_OPTIONS;

  protected readonly filtersForm = new FormGroup({
    status: new FormControl<string>(''),
    invoiceNumber: new FormControl<string>('', { nonNullable: true }),
  });

  constructor() {
    // Deep links and Back/Forward drive the drawer off the URL. The drawer
    // loads its own record, so a deep link works before the list arrives.
    effect(() => {
      const id = this.openId();
      untracked(() => {
        if (id !== null && this.drawers.openDrawer?.urlId !== id) this.openInvoice(id);
      });
    });
  }

  protected openRow(invoice: BuilderCommissionInvoice): void {
    this.openInvoice(invoice.id);
  }

  private openInvoice(invoiceId: string): void {
    this.drawers.open<AdminInvoiceDrawerComponent, void, AdminInvoiceDrawerData>(AdminInvoiceDrawerComponent, {
      data: { invoiceId },
      size: 'lg',
      urlId: invoiceId,
      injector: this.injector,
    });
  }

  ngOnInit(): void {
    this.store.dispatch(new LoadAdminInvoices());

    // Invoice-number search is debounced (shared timings.debounceMs); the
    // status select applies on change.
    this.filtersForm.controls.invoiceNumber.valueChanges
      .pipe(
        debounceTime(this.config.get('timings').debounceMs),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.applyFilters());
  }

  /** Collects the form into backend filters; empty values are omitted. */
  private collectFilters(): AdminInvoiceFilters {
    const raw = this.filtersForm.getRawValue();
    const status = (raw.status ?? '').trim();
    const invoiceNumber = raw.invoiceNumber.trim();
    return {
      status: status.length > 0 ? status : null,
      invoiceNumber: invoiceNumber.length > 0 ? invoiceNumber : null,
    };
  }

  protected applyFilters(): void {
    this.store.dispatch(new SetAdminInvoiceFilters(this.collectFilters()));
  }

  protected onStatusChange(): void {
    this.applyFilters();
  }

  protected clearFilters(): void {
    this.filtersForm.reset({ status: '', invoiceNumber: '' });
    this.applyFilters();
  }

  protected hasActiveFilters(): boolean {
    const f = this.collectFilters();
    return f.status !== null || f.invoiceNumber !== null;
  }

  protected prevPage(): void {
    const page = this.page();
    if (page > 1 && this.listStatus() !== 'loading') {
      this.store.dispatch(
        new LoadAdminInvoices(page - 1, this.pageSize(), this.filters()),
      );
    }
  }

  protected nextPage(): void {
    if (this.hasNextPage() && this.listStatus() !== 'loading') {
      this.store.dispatch(
        new LoadAdminInvoices(this.page() + 1, this.pageSize(), this.filters()),
      );
    }
  }

  /**
   * The list endpoint reports no total, so "has next" is inferred from a
   * full page. (The same degrade pattern the builder portal uses.)
   */
  protected hasNextPage(): boolean {
    return this.invoices().length === this.pageSize();
  }

  protected retry(): void {
    this.store.dispatch(
      new LoadAdminInvoices(this.page(), this.pageSize(), this.filters()),
    );
  }

  protected dismissError(): void {
    this.store.dispatch(new DismissAdminInvoiceListError());
  }
}
