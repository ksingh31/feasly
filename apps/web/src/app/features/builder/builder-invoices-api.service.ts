import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, delay, of, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type { CommissionInvoice } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Paginated invoice list — the documented wire shape for
 * `GET /api/v1/billing/invoices` (BILL-04, backend lane in progress).
 */
export interface InvoiceListResponse {
  readonly invoices: readonly CommissionInvoice[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

// ---------------------------------------------------------------------------
// PLACEHOLDER — BILL-04 backend not live yet.
// ---------------------------------------------------------------------------
// The backend lane is building `GET /api/v1/billing/invoices` (paginated,
// tenant-scoped) in parallel. Until that endpoint lands, this service serves
// realistic mock invoices in the documented wire shape so the UI can ship
// and be QA'd end to end.
//
// CUTOVER: when the endpoint is live, delete the mock branch below (and
// `mockInvoices`/`USE_PLACEHOLDER_INVOICES`) and let `listInvoices` /
// `getInvoice` hit the real routes. The `InvoiceListResponse` shape above is
// the contract the backend lane agreed to; reconcile before deleting.
// ---------------------------------------------------------------------------
const USE_PLACEHOLDER_INVOICES = true;

/** Mock invoices covering every visible status (PLACEHOLDER data). */
function mockInvoices(): CommissionInvoice[] {
  const day = 86_400_000;
  const now = Date.now();
  const iso = (t: number): string => new Date(t).toISOString();
  return [
    {
      id: 'inv-mock-001',
      tenantKey: 'mock-tenant',
      attributionId: 'attr-mock-001',
      leadId: 'lead-mock-001',
      contractValueCents: 68500000,
      commissionCents: 685000,
      currency: 'CAD',
      stripePaymentIntentId: null,
      status: 'in_review',
      reviewDueAt: iso(now + 3 * day),
      finalizedAt: null,
      paidAt: null,
      slaBreached: false,
      disputeReason: null,
      createdAt: iso(now - 4 * day),
      updatedAt: iso(now - 4 * day),
    },
    {
      id: 'inv-mock-002',
      tenantKey: 'mock-tenant',
      attributionId: 'attr-mock-002',
      leadId: 'lead-mock-002',
      contractValueCents: 74250000,
      commissionCents: 742500,
      currency: 'CAD',
      stripePaymentIntentId: 'pi_mock_paid_001',
      status: 'paid',
      reviewDueAt: iso(now - 9 * day),
      finalizedAt: iso(now - 2 * day),
      paidAt: iso(now - 2 * day),
      slaBreached: false,
      disputeReason: null,
      createdAt: iso(now - 9 * day),
      updatedAt: iso(now - 2 * day),
    },
    {
      id: 'inv-mock-003',
      tenantKey: 'mock-tenant',
      attributionId: 'attr-mock-003',
      leadId: 'lead-mock-003',
      contractValueCents: 59800000,
      commissionCents: 598000,
      currency: 'CAD',
      stripePaymentIntentId: 'pi_mock_failed_001',
      status: 'failed',
      reviewDueAt: iso(now - 3 * day),
      finalizedAt: iso(now - 3 * day),
      paidAt: null,
      slaBreached: false,
      disputeReason: null,
      createdAt: iso(now - 10 * day),
      updatedAt: iso(now - 1 * day),
    },
    {
      id: 'inv-mock-004',
      tenantKey: 'mock-tenant',
      attributionId: 'attr-mock-004',
      leadId: 'lead-mock-004',
      contractValueCents: 81000000,
      commissionCents: 810000,
      currency: 'CAD',
      stripePaymentIntentId: null,
      status: 'disputed',
      reviewDueAt: iso(now - 5 * day),
      finalizedAt: null,
      paidAt: null,
      slaBreached: true,
      disputeReason: 'Contract value disputed',
      createdAt: iso(now - 12 * day),
      updatedAt: iso(now - 5 * day),
    },
    {
      id: 'inv-mock-005',
      tenantKey: 'mock-tenant',
      attributionId: 'attr-mock-005',
      leadId: 'lead-mock-005',
      contractValueCents: 65500000,
      commissionCents: 655000,
      currency: 'CAD',
      stripePaymentIntentId: 'pi_mock_paid_002',
      status: 'paid',
      reviewDueAt: iso(now - 16 * day),
      finalizedAt: iso(now - 9 * day),
      paidAt: iso(now - 9 * day),
      slaBreached: false,
      disputeReason: null,
      createdAt: iso(now - 16 * day),
      updatedAt: iso(now - 9 * day),
    },
    {
      id: 'inv-mock-006',
      tenantKey: 'mock-tenant',
      attributionId: 'attr-mock-006',
      leadId: 'lead-mock-006',
      contractValueCents: 70300000,
      commissionCents: 703000,
      currency: 'CAD',
      stripePaymentIntentId: null,
      status: 'finalized',
      reviewDueAt: iso(now - 1 * day),
      finalizedAt: iso(now - 1 * day),
      paidAt: null,
      slaBreached: false,
      disputeReason: null,
      createdAt: iso(now - 8 * day),
      updatedAt: iso(now - 1 * day),
    },
  ];
}

/**
 * Builder invoices API client (BILL-04).
 *
 * Speaks the versioned `/api/v1/billing/invoices` routes behind the builder
 * session cookie (`withCredentials: true`). Every call is tenant-scoped
 * server-side; a builder can only ever see their own tenant's invoices.
 *
 * Not wired to the mock API — the builder portal always talks to the real
 * backend. See the PLACEHOLDER block above: list/detail currently serve
 * mock data until the backend endpoint lands.
 */
@Injectable({ providedIn: 'root' })
export class BuilderInvoicesApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get billingBase(): string {
    const v1 = `${this.config.get('api').baseUrl}/api/v1`;
    return `${v1}/billing`;
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /**
   * Paginated invoice list, newest first. PLACEHOLDER: serves mock data
   * until `GET /api/v1/billing/invoices` is live (see top of file).
   */
  listInvoices(page: number, pageSize: number): Observable<InvoiceListResponse> {
    if (USE_PLACEHOLDER_INVOICES) {
      const all = mockInvoices();
      const start = (page - 1) * pageSize;
      return of({
        invoices: all.slice(start, start + pageSize),
        total: all.length,
        page,
        pageSize,
      }).pipe(delay(150));
    }
    return this.call(
      this.http.get<InvoiceListResponse>(`${this.billingBase}/invoices`, {
        params: { page: String(page), pageSize: String(pageSize) },
        withCredentials: true,
      }),
    );
  }

  /**
   * Single invoice. PLACEHOLDER: resolves from the mock dataset until the
   * backend list endpoint lands (the real single-invoice route exists, but
   * mock ids are not real rows — resolving locally keeps list/detail
   * consistent while the placeholder is active).
   */
  getInvoice(id: string): Observable<CommissionInvoice> {
    if (USE_PLACEHOLDER_INVOICES) {
      const found = mockInvoices().find((inv) => inv.id === id);
      if (!found) {
        throw new Error(`Placeholder invoice not found: ${id}`);
      }
      return of(found).pipe(delay(150));
    }
    return this.call(
      this.http.get<CommissionInvoice>(`${this.billingBase}/invoices/${id}`, {
        withCredentials: true,
      }),
    );
  }
}
