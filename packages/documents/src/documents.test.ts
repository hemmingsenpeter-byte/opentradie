import { createQuoteDraft, reviseQuote, transitionQuote, type LineInput } from '@opentradie/core';
import { describe, expect, it } from 'vitest';
import {
  buildInvoiceDocumentModel,
  buildQuoteDocumentModel,
  DocumentIncompleteError,
  formatDocumentDate,
  renderInvoicePdf,
  renderQuotePdf,
} from './index.js';

const business = {
  name: 'Kowhai Electrical Ltd',
  gstNumber: '123-456-789',
  address: '1 Workshop Lane, Petone',
  phone: '04 555 0100',
  email: 'office@example.test',
};
const customer = {
  name: 'Aroha Smith',
  address: '12 Example Street, Wellington',
  email: 'aroha@example.test',
};
const gst = {
  gstRegistered: true,
  pricesEntered: 'exclusive' as const,
  standardRateBasisPoints: 1500,
};
const lines: LineInput[] = [
  {
    kind: 'labour',
    description: 'Electrician labour',
    unit: 'hour',
    quantityMilli: 1_500,
    price: { source: 'approved_rate', rateCode: 'labour_hour', unitPriceCents: 11_000 },
    taxCode: 'standard',
  },
  {
    kind: 'material',
    description: 'Double power point',
    unit: 'each',
    quantityMilli: 2_000,
    price: { source: 'cost_plus_markup', costCents: 1_840, markupBasisPoints: 2_500 },
    taxCode: 'standard',
  },
  {
    kind: 'discount',
    description: 'Repeat customer discount',
    unit: 'each',
    quantityMilli: 1_000,
    price: {
      source: 'owner_entered',
      unitPriceCents: 1_000,
      enteredByRole: 'owner',
      enteredByUserId: 'owner-1',
    },
    taxCode: 'standard',
  },
];
const quote = createQuoteDraft({
  quoteNumber: 'Q-0042',
  lines,
  issueDate: '2026-10-19',
  terms: 'Payment within 7 days of completion.',
});

describe('document model (pure)', () => {
  it('builds a GST-registered quote: title Quote, GST shown, never a tax invoice', () => {
    const model = buildQuoteDocumentModel({
      business,
      customer,
      site: '12 Example Street',
      tax: gst,
      quote,
    });
    expect(model.title).toBe('Quote');
    expect(model.number).toBe('Q-0042');
    expect(model.versionLabel).toBe('Version 1');
    expect(model.business.gstNumberLabel).toBe('GST No. 123-456-789');
    expect(model.dates).toEqual([
      { label: 'Date', value: '19 October 2026' },
      { label: 'Valid until', value: '18 November 2026' },
    ]);
    // 1.5 h × $110 = $165.00; 2 × $23.00 = $46.00; −$10.00 → $201.00 + GST $30.15 = $231.15
    expect(model.lines).toEqual([
      {
        description: 'Electrician labour',
        quantity: '1.5',
        unit: 'h',
        unitPrice: '$110.00',
        amount: '$165.00',
      },
      {
        description: 'Double power point',
        quantity: '2',
        unit: 'ea',
        unitPrice: '$23.00',
        amount: '$46.00',
      },
      {
        description: 'Repeat customer discount',
        quantity: '1',
        unit: 'ea',
        unitPrice: '-$10.00',
        amount: '-$10.00',
      },
    ]);
    expect(model.totals).toEqual([
      { label: 'Subtotal (excl. GST)', value: '$201.00', emphasis: false },
      { label: 'GST 15%', value: '$30.15', emphasis: false },
      { label: 'Total (incl. GST)', value: '$231.15', emphasis: true },
    ]);
    expect(model.amountColumnLabel).toBe('Amount (excl. GST)');
    expect(model.notes).toContain('A quote is not a tax invoice.');
    expect(model.notes).toContain('This quote is valid until 18 November 2026.');
    expect(model.acceptanceNote).toMatch(/Q-0042 version 1 on or before 18 November 2026/);
    expect(model.taxableSupply).toBeNull();
    expect(JSON.stringify(model)).not.toMatch(/tax invoice"/i);
  });

  it('labels a revised version and shows inclusive pricing', () => {
    const sent = transitionQuote(quote, 'sent', new Date('2026-10-19T00:00:00Z'));
    const { next } = reviseQuote(sent, { issueDate: '2026-10-21' });
    const model = buildQuoteDocumentModel({
      business,
      customer,
      tax: { ...gst, pricesEntered: 'inclusive' },
      quote: next,
    });
    expect(model.versionLabel).toBe('Version 2');
    expect(model.notes).toContain('Version 2 replaces all earlier versions of quote Q-0042.');
    expect(model.amountColumnLabel).toBe('Amount (incl. GST)');
    // $201.00 inclusive → GST round(20100 × 3/23 = 2621.74) = $26.22
    expect(model.totals.map((row) => row.value)).toEqual(['$174.78', '$26.22', '$201.00']);
    expect(model.siteLabel).toBeNull();
  });

  it('a business that is not GST-registered shows no GST anywhere', () => {
    const model = buildInvoiceDocumentModel({
      business: { ...business, gstNumber: '123-456-789' },
      customer,
      tax: { ...gst, gstRegistered: false },
      invoiceNumber: 'INV-0007',
      issueDate: '2026-10-19',
      dueDate: '2026-10-26',
      lines,
    });
    expect(model.title).toBe('Invoice');
    expect(model.business.gstNumberLabel).toBeNull();
    expect(model.totals).toEqual([{ label: 'Total', value: '$201.00', emphasis: true }]);
    expect(model.amountColumnLabel).toBe('Amount');
    const visible = JSON.stringify({ ...model, totalsCents: undefined, taxableSupply: undefined });
    expect(visible).not.toMatch(/GST No|Tax invoice|excl\. GST|incl\. GST/);
    expect(model.notes[0]).toMatch(/not registered for GST/);
    expect(model.taxableSupply).toEqual({ tier: 'not_registered', missing: [], problems: [] });
  });

  it('builds a GST-registered tax invoice and checks taxable supply information', () => {
    const model = buildInvoiceDocumentModel({
      business,
      customer,
      site: null,
      tax: gst,
      invoiceNumber: 'INV-0008',
      issueDate: '2026-10-19',
      dueDate: '2026-10-26',
      lines: [...lines, { ...lines[0]!, quantityMilli: 8_000, taxCode: 'zero_rated' }],
      quoteReference: 'Q-0042 v1',
    });
    expect(model.title).toBe('Tax invoice');
    expect(model.lines[3]!.description).toBe('Electrician labour (zero-rated)');
    expect(model.notes).toContain('Lines marked zero-rated or GST exempt carry no GST.');
    expect(model.notes).toContain('Work as quoted in Q-0042 v1.');
    expect(model.taxableSupply).toEqual({ tier: 'over_1000', missing: [], problems: [] });
  });

  it('rejects incomplete inputs', () => {
    expect(() =>
      buildQuoteDocumentModel({
        business: { ...business, gstNumber: null },
        customer,
        tax: gst,
        quote,
      }),
    ).toThrow(/GST number/);
    expect(() =>
      buildQuoteDocumentModel({ business, customer: { name: ' ' }, tax: gst, quote }),
    ).toThrow();
    expect(() =>
      buildInvoiceDocumentModel({
        business,
        customer,
        tax: gst,
        invoiceNumber: 'INV-1',
        issueDate: '2026-10-19',
        dueDate: '2026-10-18',
        lines,
      }),
    ).toThrow(/due date/);
  });

  it('formats date-only values without time zone drift', () => {
    expect(formatDocumentDate('2026-01-01')).toBe('1 January 2026');
    expect(formatDocumentDate('2026-12-31')).toBe('31 December 2026');
  });
});

describe('PDF rendering', () => {
  it('renders a quote to a PDF buffer', async () => {
    const pdf = await renderQuotePdf(
      buildQuoteDocumentModel({ business, customer, site: 'Kitchen', tax: gst, quote }),
    );
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1_000);
    // Only base-14 Helvetica: no embedded font programs.
    expect(pdf.toString('latin1')).toMatch(/\/BaseFont \/Helvetica/);
    expect(pdf.toString('latin1')).not.toMatch(/\/FontFile/);
  });

  it('renders a long multi-page invoice', async () => {
    const many: LineInput[] = Array.from({ length: 80 }, (_, i) => ({
      ...lines[0]!,
      description: `Task ${i + 1}`,
    }));
    const model = buildInvoiceDocumentModel({
      business,
      customer,
      tax: gst,
      invoiceNumber: 'INV-0009',
      issueDate: '2026-10-19',
      dueDate: '2026-11-20',
      lines: many,
    });
    const pdf = await renderInvoicePdf(model);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });

  it('refuses to render an invoice that lacks taxable supply information', async () => {
    const model = buildInvoiceDocumentModel({
      business,
      customer: { name: 'Walk-in customer' },
      tax: gst,
      invoiceNumber: 'INV-0010',
      issueDate: '2026-10-19',
      dueDate: '2026-10-26',
      lines: [{ ...lines[0]!, quantityMilli: 10_000 }],
    });
    expect(model.taxableSupply?.missing).toEqual([
      'recipient identifier (address, phone, email, NZBN, trading name or website)',
    ]);
    await expect(renderInvoicePdf(model)).rejects.toBeInstanceOf(DocumentIncompleteError);
  });

  it('will not render a quote model as an invoice or vice versa', async () => {
    const model = buildQuoteDocumentModel({ business, customer, tax: gst, quote });
    await expect(renderInvoicePdf(model)).rejects.toThrow(TypeError);
  });
});
