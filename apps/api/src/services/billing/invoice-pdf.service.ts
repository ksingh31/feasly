/**
 * Builder invoice PDF / receipt (#661, follow-up to #533 builder review
 * Should-fix 4).
 *
 * Renders one commission invoice to a PDF from the SAME server record the
 * JSON endpoints return — every figure (contract value, rate, commission)
 * is read from the invoice row, formatted only; nothing is recomputed.
 * Paid invoices carry a receipt block (amount, charge date, card used or
 * the manual method + reference).
 *
 * Tenant isolation: a builder asking for another tenant's invoice gets a
 * 404 (not the 403 the JSON read returns) so the endpoint never confirms
 * that a foreign invoice id exists.
 */
import type { Builder } from '@feasly/contracts';
import { ErrorCodes, HttpError } from '../../middleware/errors';
import { DISPUTE_SLA_TIMEZONE } from '../../lib/business-days';
import { renderPdf, type PdfOp } from '../../lib/simple-pdf';
import type { BillingService } from './billing.service';
import type { CommissionCardService } from './commission-card.service';
import type {
  CommissionInvoiceRecord,
  CommissionInvoiceStatus,
} from './commission.service';

/** Every human-readable string on the PDF, in one place. */
export const INVOICE_PDF_COPY = {
  title: 'Commission invoice',
  issuer: 'Feasly',
  numberLabel: 'Invoice number',
  statusLabel: 'Status',
  issuedLabel: 'Issued',
  billedToLabel: 'Billed to',
  leadLabel: 'Lead',
  breakdownHeading: 'Breakdown',
  contractLabel: 'Contract value',
  rateLabel: 'Commission rate',
  commissionLabel: 'Commission',
  paymentHeading: 'Payment',
  methodLabel: 'Payment method',
  reviewEndsLabel: 'Review window ends',
  chargeTiming:
    'We charge your card 7 days after the invoice is issued. You can question it any time before then.',
  receiptHeading: 'Receipt',
  receiptAmount: 'Amount charged',
  receiptDate: 'Charge date',
  receiptCard: 'Card used',
  receiptPaidBy: 'Paid by',
  receiptReference: 'Reference',
  none: '—',
  statuses: {
    draft: 'Draft',
    in_review: 'In review',
    finalized: 'Finalized',
    paid: 'Paid',
    failed: 'Failed',
    disputed: 'Disputed',
    void: 'Void',
  } satisfies Record<CommissionInvoiceStatus, string>,
  methods: {
    card: 'Card on file',
    cheque: 'Cheque',
    e_transfer: 'E-transfer',
    bank_draft: 'Bank draft',
  } as Readonly<Record<string, string>>,
} as const;

export interface InvoicePdfResult {
  readonly pdf: Buffer;
  readonly filename: string;
}

export interface InvoicePdfService {
  /**
   * Render the invoice PDF. `tenantKey` scopes a builder to their own
   * invoices (404 otherwise); admins pass null.
   */
  renderInvoicePdf(
    invoiceId: string,
    tenantKey: string | null,
  ): Promise<InvoicePdfResult>;
}

export interface InvoicePdfServiceDeps {
  readonly billing: Pick<BillingService, 'getInvoice'>;
  readonly commissionCard: Pick<CommissionCardService, 'getCard'>;
  readonly builders: { getByTenantKey(tenantKey: string): Promise<Builder | null> };
}

/** "$1,234.56" from integer cents. */
export function formatInvoiceCad(cents: number): string {
  const amount = (Math.abs(cents) / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? '-' : ''}$${amount}`;
}

/** 1 → "1%", 1.5 → "1.5%" (no float dust). */
function formatRate(ratePercent: number): string {
  return `${Number((Math.round(ratePercent * 10_000) / 10_000).toFixed(4))}%`;
}

/** Day-level date in America/Edmonton, e.g. "Nov 15, 2026". */
function formatDate(date: Date | null): string {
  if (!date) return INVOICE_PDF_COPY.none;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPUTE_SLA_TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/** Inputs to the pure layout — everything already resolved. */
export interface InvoicePdfModel {
  readonly invoice: CommissionInvoiceRecord;
  readonly billedTo: string | null;
  /** "Visa •••• 4242" when known; null otherwise. */
  readonly card: string | null;
}

/** Pure layout: model → page ops. Exported for tests. */
export function layoutInvoicePdf(model: InvoicePdfModel): PdfOp[] {
  const c = INVOICE_PDF_COPY;
  const inv = model.invoice;
  const left = 72;
  const valueX = 260;
  const right = 540;
  const ops: PdfOp[] = [];
  let y = 84;

  const row = (label: string, value: string, bold = false) => {
    ops.push({ kind: 'text', x: left, y, size: 11, text: label });
    ops.push({ kind: 'text', x: valueX, y, size: 11, bold, text: value });
    y += 20;
  };
  const heading = (text: string) => {
    y += 14;
    ops.push({ kind: 'text', x: left, y, size: 12, bold: true, text });
    y += 8;
    ops.push({ kind: 'rule', x1: left, x2: right, y });
    y += 20;
  };

  ops.push({ kind: 'text', x: left, y, size: 20, bold: true, text: c.title });
  ops.push({ kind: 'text', x: valueX + 160, y, size: 12, bold: true, text: c.issuer });
  y += 34;

  row(c.numberLabel, inv.invoiceNumber, true);
  row(c.statusLabel, c.statuses[inv.status] ?? inv.status);
  row(c.issuedLabel, formatDate(inv.createdAt));
  if (model.billedTo) row(c.billedToLabel, model.billedTo);
  row(c.leadLabel, inv.leadName || c.none);

  heading(c.breakdownHeading);
  row(c.contractLabel, formatInvoiceCad(inv.contractValueCents));
  row(c.rateLabel, formatRate(inv.effectiveRatePercent));
  row(c.commissionLabel, formatInvoiceCad(inv.commissionCents), true);

  heading(c.paymentHeading);
  row(c.methodLabel, c.methods[inv.paymentMethod] ?? inv.paymentMethod);
  if (inv.status === 'in_review' && inv.reviewDueAt) {
    row(c.reviewEndsLabel, formatDate(inv.reviewDueAt));
  }
  const unpaidCard =
    inv.paymentMethod === 'card' &&
    (inv.status === 'draft' || inv.status === 'in_review');
  if (unpaidCard) {
    ops.push({ kind: 'text', x: left, y, size: 9, text: c.chargeTiming });
    y += 20;
  }

  if (inv.status === 'paid') {
    heading(c.receiptHeading);
    row(c.receiptAmount, formatInvoiceCad(inv.commissionCents), true);
    row(c.receiptDate, formatDate(inv.paidAt));
    if (inv.manualPaymentMethod) {
      row(c.receiptPaidBy, c.methods[inv.manualPaymentMethod] ?? inv.manualPaymentMethod);
      if (inv.paymentReference) row(c.receiptReference, inv.paymentReference);
    } else {
      row(c.receiptCard, model.card ?? c.none);
    }
  }
  return ops;
}

/** Filename-safe invoice number, e.g. "feasly-INV-0042.pdf". */
export function invoicePdfFilename(invoiceNumber: string): string {
  const safe = invoiceNumber.replace(/[^A-Za-z0-9-]/g, '') || 'invoice';
  return `feasly-${safe}.pdf`;
}

export function createInvoicePdfService(
  deps: InvoicePdfServiceDeps,
): InvoicePdfService {
  const { billing, commissionCard, builders } = deps;

  async function loadInvoice(
    invoiceId: string,
    tenantKey: string | null,
  ): Promise<CommissionInvoiceRecord> {
    try {
      return await billing.getInvoice(invoiceId, tenantKey);
    } catch (err) {
      // Foreign invoice → 404, so the id's existence is never confirmed.
      if (err instanceof HttpError && err.status === 403) {
        throw new HttpError(404, ErrorCodes.NOT_FOUND, 'Invoice not found.');
      }
      throw err;
    }
  }

  /** Best-effort card label for the receipt; never fails the download. */
  async function cardLabel(tenantKey: string): Promise<string | null> {
    try {
      const card = await commissionCard.getCard(tenantKey);
      if (!card.hasCard) return null;
      return `${card.brand ?? ''} •••• ${card.last4 ?? ''}`.trim();
    } catch {
      return null;
    }
  }

  async function billedTo(tenantKey: string): Promise<string | null> {
    try {
      const builder = await builders.getByTenantKey(tenantKey);
      return builder?.businessName || builder?.displayName || null;
    } catch {
      return null;
    }
  }

  return {
    async renderInvoicePdf(invoiceId, tenantKey) {
      const invoice = await loadInvoice(invoiceId, tenantKey);
      const needsCard =
        invoice.status === 'paid' && invoice.manualPaymentMethod === null;
      const [name, card] = await Promise.all([
        billedTo(invoice.tenantKey),
        needsCard ? cardLabel(invoice.tenantKey) : Promise.resolve(null),
      ]);
      const pdf = renderPdf({
        title: `${INVOICE_PDF_COPY.title} ${invoice.invoiceNumber}`,
        ops: layoutInvoicePdf({ invoice, billedTo: name, card }),
      });
      return { pdf, filename: invoicePdfFilename(invoice.invoiceNumber) };
    },
  };
}
