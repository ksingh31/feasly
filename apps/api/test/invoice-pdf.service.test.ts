/**
 * #661 invoice PDF/receipt tests: the pure PDF writer, the invoice layout,
 * and the service's tenant scoping (another tenant's id → 404).
 *
 * The PDF is uncompressed, so rendered text is asserted by reading the
 * content stream back as latin1.
 */
import { describe, expect, it, vi } from 'vitest';
import { encodePdfText, renderPdf } from '../src/lib/simple-pdf';
import {
  createInvoicePdfService,
  formatInvoiceCad,
  invoicePdfFilename,
  INVOICE_PDF_COPY,
} from '../src/services/billing/invoice-pdf.service';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type { CommissionInvoiceRecord } from '../src/services/billing/commission.service';

const INVOICE_ID = '00000000-0000-4000-8000-000000000031';

function invoice(over: Partial<CommissionInvoiceRecord> = {}): CommissionInvoiceRecord {
  return {
    id: INVOICE_ID,
    tenantKey: 'elite-craft',
    attributionId: 'attr-1',
    leadId: 'lead-1',
    leadName: 'Jordan (Lot 7)',
    contractValueCents: 50_000_000,
    commissionCents: 500_000,
    subtotalCents: 500_000,
    taxRatePercent: 0,
    taxInclusive: false,
    taxCents: 0,
    totalCents: 500_000,
    taxLabel: null,
    currency: 'cad',
    stripePaymentIntentId: null,
    status: 'in_review',
    reviewDueAt: new Date('2026-11-20T18:00:00Z'),
    finalizedAt: null,
    paidAt: null,
    slaBreached: false,
    disputeReason: null,
    retryCount: 0,
    commissionRateOverride: null,
    commissionRatePercent: 1,
    effectiveRatePercent: 1,
    manualPaymentMethod: null,
    paymentReference: null,
    invoiceNumber: 'INV-0042',
    paymentMethod: 'card',
    createdAt: new Date('2026-11-13T18:00:00Z'),
    updatedAt: new Date('2026-11-13T18:00:00Z'),
    ...over,
  };
}

function makeService(record: CommissionInvoiceRecord, card = { hasCard: true, brand: 'visa', last4: '4242' }) {
  const billing = {
    getInvoice: vi.fn(async (_id: string, tenantKey: string | null) => {
      if (tenantKey !== null && tenantKey !== record.tenantKey) {
        throw new HttpError(403, ErrorCodes.FORBIDDEN, 'This invoice belongs to a different builder.');
      }
      return record;
    }),
  };
  const commissionCard = { getCard: vi.fn(async () => card) };
  const builders = {
    getByTenantKey: vi.fn(async () => ({ businessName: 'Elite Craft Builders', displayName: 'Elite Craft' }) as never),
  };
  return {
    service: createInvoicePdfService({ billing, commissionCard, builders }),
    billing,
    commissionCard,
  };
}

const text = (pdf: Buffer) => pdf.toString('latin1');

describe('simple-pdf writer', () => {
  it('produces a structurally valid PDF with a correct xref offset', () => {
    const pdf = renderPdf({ title: 'T', ops: [{ kind: 'text', x: 72, y: 72, size: 12, text: 'Hello' }] });
    const s = text(pdf);
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    const startxref = Number(/startxref\n(\d+)/.exec(s)?.[1]);
    expect(s.slice(startxref, startxref + 4)).toBe('xref');
    // Every object offset in the xref points at "<n> 0 obj".
    const offsets = [...s.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((off, i) => expect(s.slice(off).startsWith(`${i + 1} 0 obj`)).toBe(true));
    expect(s).toContain('(Hello) Tj');
  });

  it('is deterministic', () => {
    const spec = { ops: [{ kind: 'text' as const, x: 1, y: 2, size: 3, text: 'x' }] };
    expect(renderPdf(spec).equals(renderPdf(spec))).toBe(true);
  });

  it('escapes PDF string delimiters and maps non-WinAnsi characters', () => {
    expect(encodePdfText('a(b)c\\')).toBe('a\\(b\\)c\\\\');
    expect(encodePdfText('•—')).toBe('\x95\x97');
    expect(encodePdfText('日​')).toBe('??');
    expect(encodePdfText('é×')).toBe('é×');
  });
});

describe('invoice PDF service', () => {
  it('renders the invoice figures from the server record', async () => {
    const { service } = makeService(invoice());
    const { pdf, filename } = await service.renderInvoicePdf(INVOICE_ID, 'elite-craft');
    const s = text(pdf);
    expect(filename).toBe('feasly-INV-0042.pdf');
    expect(s).toContain('(INV-0042)');
    expect(s).toContain('(Jordan \\(Lot 7\\))');
    expect(s).toContain('(Elite Craft Builders)');
    expect(s).toContain(`(${formatInvoiceCad(50_000_000)})`);
    expect(s).toContain('($5,000.00)');
    expect(s).toContain('(1%)');
    expect(s).toContain(`(${INVOICE_PDF_COPY.chargeTiming})`);
    expect(s).not.toContain(`(${INVOICE_PDF_COPY.receiptHeading})`);
  });

  it('paid card invoices include the receipt block with the card used', async () => {
    const { service } = makeService(
      invoice({ status: 'paid', paidAt: new Date('2026-11-14T18:00:00Z') }),
    );
    const s = text((await service.renderInvoicePdf(INVOICE_ID, 'elite-craft')).pdf);
    expect(s).toContain(`(${INVOICE_PDF_COPY.receiptHeading})`);
    expect(s).toContain(`(${INVOICE_PDF_COPY.receiptAmount})`);
    expect(s).toContain('(Nov 14, 2026)');
    expect(s).toContain('(visa \x95\x95\x95\x95 4242)');
    expect(s).not.toContain(`(${INVOICE_PDF_COPY.chargeTiming})`);
  });

  it('manually paid invoices show the method and reference instead of a card', async () => {
    const { service, commissionCard } = makeService(
      invoice({
        status: 'paid',
        paidAt: new Date('2026-11-14T18:00:00Z'),
        paymentMethod: 'cheque',
        manualPaymentMethod: 'cheque',
        paymentReference: 'CHQ-118',
      }),
    );
    const s = text((await service.renderInvoicePdf(INVOICE_ID, 'elite-craft')).pdf);
    expect(s).toContain(`(${INVOICE_PDF_COPY.receiptPaidBy})`);
    expect(s).toContain('(CHQ-118)');
    expect(commissionCard.getCard).not.toHaveBeenCalled();
  });

  it('a card lookup failure never fails the download', async () => {
    const { service, commissionCard } = makeService(
      invoice({ status: 'paid', paidAt: new Date('2026-11-14T18:00:00Z') }),
    );
    commissionCard.getCard.mockRejectedValueOnce(new Error('stripe down'));
    const s = text((await service.renderInvoicePdf(INVOICE_ID, 'elite-craft')).pdf);
    expect(s).toContain(`(${INVOICE_PDF_COPY.receiptCard})`);
  });

  it("another tenant's invoice id is a 404", async () => {
    const { service } = makeService(invoice());
    await expect(service.renderInvoicePdf(INVOICE_ID, 'other-builder')).rejects.toMatchObject({
      status: 404,
      code: ErrorCodes.NOT_FOUND,
    });
  });

  it('admins (tenantKey null) render any invoice', async () => {
    const { service, billing } = makeService(invoice());
    await service.renderInvoicePdf(INVOICE_ID, null);
    expect(billing.getInvoice).toHaveBeenCalledWith(INVOICE_ID, null);
  });

  it('builds a filename-safe name', () => {
    expect(invoicePdfFilename('INV-0042')).toBe('feasly-INV-0042.pdf');
    expect(invoicePdfFilename('../"x')).toBe('feasly-x.pdf');
    expect(invoicePdfFilename('')).toBe('feasly-invoice.pdf');
  });
});

describe('invoice PDF — GST (#714)', () => {
  const TAX = {
    label: 'GST',
    supplierLegalName: 'Example Holdings Ltd.',
    supplierAddress: '100 Example St SW, Calgary AB',
    registrationNumber: '123456789RT0001',
  };
  // AC1 figures: $1,250,000 contract at 1.5% + 5% GST.
  const taxed = (over: Partial<CommissionInvoiceRecord> = {}) =>
    invoice({
      contractValueCents: 125_000_000,
      commissionCents: 1_875_000,
      subtotalCents: 1_875_000,
      effectiveRatePercent: 1.5,
      taxRatePercent: 5,
      taxCents: 93_750,
      totalCents: 1_968_750,
      taxLabel: 'GST',
      ...over,
    });

  function render(record: CommissionInvoiceRecord, tax: typeof TAX | undefined = TAX) {
    const builders = {
      getByTenantKey: vi.fn(async () => ({ businessName: 'Elite Craft Builders', displayName: 'Elite Craft' }) as never),
    };
    return createInvoicePdfService({
      billing: { getInvoice: vi.fn(async () => record) },
      commissionCard: { getCard: vi.fn(async () => ({ hasCard: true, brand: 'visa', last4: '4242' }) as never) },
      builders,
      ...(tax ? { tax } : {}),
    }).renderInvoicePdf(INVOICE_ID, null);
  }

  it('shows subtotal, tax label + rate, tax, total, registration number and supplier details (AC5)', async () => {
    const s = text((await render(taxed())).pdf);
    expect(s).toContain("(Commission \\(subtotal\\))");
    expect(s).toContain('($18,750.00)');
    expect(s).toContain('(GST \\(5%\\))');
    expect(s).toContain('($937.50)');
    expect(s).toContain(`(${INVOICE_PDF_COPY.totalLabel})`);
    expect(s).toContain('($19,687.50)');
    expect(s).toContain('(GST registration number)');
    expect(s).toContain('(123456789RT0001)');
    expect(s).toContain('(Example Holdings Ltd.)');
    expect(s).toContain('(100 Example St SW, Calgary AB)');
    expect(s).toContain('(Elite Craft Builders)');
  });

  it('paid taxed invoices show the same breakdown on the receipt block (AC5)', async () => {
    const s = text(
      (await render(taxed({ status: 'paid', paidAt: new Date('2026-11-14T18:00:00Z') }))).pdf,
    );
    const receipt = s.slice(s.indexOf(`(${INVOICE_PDF_COPY.receiptHeading})`));
    expect(receipt).toContain('($19,687.50)');
    expect(receipt).toContain('($18,750.00)');
    expect(receipt).toContain('(GST \\(5%\\))');
    expect(receipt).toContain('($937.50)');
  });

  it('untaxed invoices render byte-identically with or without tax config (AC2)', async () => {
    const plain = invoice();
    const withConfig = await render(plain, TAX);
    const without = await render(plain, undefined);
    expect(withConfig.pdf.equals(without.pdf)).toBe(true);
    expect(text(withConfig.pdf)).not.toContain('(GST');
    expect(text(withConfig.pdf)).not.toContain('(123456789RT0001)');
  });
});
