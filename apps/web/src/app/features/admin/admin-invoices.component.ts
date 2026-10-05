import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { ConfigService } from '../../core/config/config.service';
import { formatCentsToCad } from '../../shared/utils/money';
import {
  ADMIN_INVOICE_STATUS_OPTIONS,
  DismissAdminInvoiceListError,
  LoadAdminInvoices,
  SetAdminInvoiceFilters,
} from './admin-invoices.actions';
import type { AdminInvoiceFilters } from './admin-invoices.actions';
import { AdminInvoicesState } from './admin-invoices.state';
import type { BuilderCommissionInvoice } from '../builder/builder-invoices-api.service';

/**
 * Admin invoice list (QA admin-console fix 3): every commission invoice
 * across tenants, newest first, with a status filter, an invoice-number
 * search, and pagination. Rows link to the standalone invoice detail
 * page — paid invoices (and every other status) are reachable here,
 * not just in the billing work queues.
 *
 * Route: `/admin/billing/invoices`, inside the admin shell.
 */
@Component({
  selector: 'app-admin-invoices',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './admin-invoices.component.html',
  styleUrl: './admin-invoices.component.scss',
})
export class AdminInvoicesComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);

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
    const status = raw.status.trim();
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

  protected formatCents(cents: number): string {
    return formatCentsToCad(cents);
  }

  protected statusLabel(status: BuilderCommissionInvoice['status']): string {
    return (
      this.statusOptions.find((o) => o.value === status)?.label ?? status
    );
  }

  protected statusClass(status: BuilderCommissionInvoice['status']): string {
    return `invoices-page__badge invoices-page__badge--${status.replace('_', '-')}`;
  }
}
