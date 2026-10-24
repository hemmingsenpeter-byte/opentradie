import {
  assertIsoDate,
  computeDocumentTotals,
  documentTitle,
  formatBasisPoints,
  formatQuantityMilli,
  formatSignedCents,
  taxableSupplyInformationRequirements,
  type DocumentKind,
  type DocumentTotals,
  type LineInput,
  type LineUnit,
  type QuoteVersion,
  type TaxCode,
  type TaxSettings,
  type TsiCheck,
} from '@opentradie/core';

/**
 * Pure builders that turn domain records into a fully formatted, render-ready document model.
 * All arithmetic happens in @opentradie/core; the renderer only lays out strings.
 */

export interface BusinessDetails {
  name: string;
  gstNumber?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  nzbn?: string | null;
}

export interface CustomerDetails {
  name: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface DocumentLineModel {
  description: string;
  /** Up to three decimals, e.g. "1.5". */
  quantity: string;
  unit: string;
  unitPrice: string;
  amount: string;
}

export interface DocumentModel {
  kind: DocumentKind;
  title: string;
  number: string;
  versionLabel: string | null;
  business: { name: string; gstNumberLabel: string | null; contactLines: string[] };
  customer: { name: string; contactLines: string[] };
  siteLabel: string | null;
  dates: { label: string; value: string }[];
  amountColumnLabel: string;
  lines: DocumentLineModel[];
  totals: { label: string; value: string; emphasis: boolean }[];
  notes: string[];
  acceptanceNote: string | null;
  totalsCents: DocumentTotals;
  /** Taxable supply information check (invoices only). */
  taxableSupply: TsiCheck | null;
}

const UNIT_LABELS: Record<LineUnit, string> = {
  each: 'ea',
  hour: 'h',
  visit: 'visit',
  metre: 'm',
  square_metre: 'sq m',
  litre: 'L',
  kilogram: 'kg',
};

const TAX_CODE_NOTES: Record<TaxCode, string> = {
  standard: '',
  zero_rated: ' (zero-rated)',
  exempt: ' (GST exempt)',
};

/** "2026-10-19" → "19 October 2026". Date-only values are formatted without time zone shifts. */
export function formatDocumentDate(isoDate: string): string {
  assertIsoDate(isoDate);
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-NZ', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

const present = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function buildCommon(input: {
  kind: DocumentKind;
  business: BusinessDetails;
  customer: CustomerDetails;
  site?: string | null;
  tax: TaxSettings;
  lines: readonly LineInput[];
}) {
  if (!present(input.business.name)) throw new RangeError('business name is required.');
  if (!present(input.customer.name)) throw new RangeError('customer name is required.');
  const registered = input.tax.gstRegistered;
  if (registered && !present(input.business.gstNumber))
    throw new RangeError('a GST-registered business needs its GST number on documents.');
  const totals = computeDocumentTotals(input.lines, input.tax);
  const rate = formatBasisPoints(input.tax.standardRateBasisPoints);
  const mixedCodes = totals.lines.some((line) => line.taxCode !== 'standard');

  const lines: DocumentLineModel[] = totals.lines.map((line) => ({
    description: line.description + (registered ? TAX_CODE_NOTES[line.taxCode] : ''),
    quantity: formatQuantityMilli(line.quantityMilli),
    unit: UNIT_LABELS[line.unit],
    unitPrice: formatSignedCents(
      line.kind === 'discount' ? -line.unitPriceCents : line.unitPriceCents,
    ),
    amount: formatSignedCents(line.amountCents),
  }));

  const totalRows: DocumentModel['totals'] = registered
    ? [
        {
          label: 'Subtotal (excl. GST)',
          value: formatSignedCents(totals.subtotalExclCents),
          emphasis: false,
        },
        { label: `GST ${rate}`, value: formatSignedCents(totals.totalTaxCents), emphasis: false },
        {
          label: 'Total (incl. GST)',
          value: formatSignedCents(totals.totalInclCents),
          emphasis: true,
        },
      ]
    : [{ label: 'Total', value: formatSignedCents(totals.totalInclCents), emphasis: true }];

  const notes: string[] = [];
  if (registered) {
    notes.push(
      input.tax.pricesEntered === 'inclusive'
        ? `Prices include GST. The total includes GST of ${formatSignedCents(totals.totalTaxCents)}.`
        : `Prices exclude GST. The total includes GST of ${formatSignedCents(totals.totalTaxCents)}.`,
    );
    if (mixedCodes) notes.push('Lines marked zero-rated or GST exempt carry no GST.');
  } else {
    notes.push(`${input.business.name.trim()} is not registered for GST. No GST is charged.`);
  }

  const contact = (details: {
    address?: string | null;
    phone?: string | null;
    email?: string | null;
  }) =>
    [details.address, details.phone, details.email].filter(present).map((value) => value.trim());

  return {
    title: documentTitle(input.kind, registered),
    business: {
      name: input.business.name.trim(),
      gstNumberLabel: registered ? `GST No. ${input.business.gstNumber!.trim()}` : null,
      contactLines: [
        ...contact(input.business),
        ...(present(input.business.nzbn) ? [`NZBN ${input.business.nzbn.trim()}`] : []),
      ],
    },
    customer: { name: input.customer.name.trim(), contactLines: contact(input.customer) },
    siteLabel: present(input.site) ? input.site.trim() : null,
    amountColumnLabel: registered
      ? input.tax.pricesEntered === 'inclusive'
        ? 'Amount (incl. GST)'
        : 'Amount (excl. GST)'
      : 'Amount',
    lines,
    totals: totalRows,
    notes,
    totalsCents: totals,
  };
}

export function buildQuoteDocumentModel(input: {
  business: BusinessDetails;
  customer: CustomerDetails;
  site?: string | null;
  tax: TaxSettings;
  quote: QuoteVersion;
}): DocumentModel {
  const common = buildCommon({ ...input, kind: 'quote', lines: input.quote.lines });
  const { quote } = input;
  const notes = [
    ...common.notes,
    `This quote is valid until ${formatDocumentDate(quote.validUntil)}.`,
  ];
  if (quote.version > 1)
    notes.push(
      `Version ${quote.version} replaces all earlier versions of quote ${quote.quoteNumber}.`,
    );
  notes.push('A quote is not a tax invoice.');
  if (quote.terms.trim()) notes.push(quote.terms.trim());
  return {
    ...common,
    kind: 'quote',
    number: quote.quoteNumber,
    versionLabel: `Version ${quote.version}`,
    dates: [
      { label: 'Date', value: formatDocumentDate(quote.issueDate) },
      { label: 'Valid until', value: formatDocumentDate(quote.validUntil) },
    ],
    notes,
    acceptanceNote: `To accept, reply to ${common.business.name} quoting ${quote.quoteNumber} version ${quote.version} on or before ${formatDocumentDate(quote.validUntil)}.`,
    taxableSupply: null,
  };
}

export function buildInvoiceDocumentModel(input: {
  business: BusinessDetails;
  customer: CustomerDetails;
  site?: string | null;
  tax: TaxSettings;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  lines: readonly LineInput[];
  terms?: string;
  quoteReference?: string | null;
}): DocumentModel {
  if (!present(input.invoiceNumber)) throw new RangeError('invoice number is required.');
  assertIsoDate(input.issueDate, 'issueDate');
  assertIsoDate(input.dueDate, 'dueDate');
  if (input.dueDate < input.issueDate) throw new RangeError('due date is before the issue date.');
  const common = buildCommon({ ...input, kind: 'invoice' });
  const notes = [...common.notes, `Payment is due by ${formatDocumentDate(input.dueDate)}.`];
  if (present(input.quoteReference))
    notes.push(`Work as quoted in ${input.quoteReference.trim()}.`);
  if (input.terms?.trim()) notes.push(input.terms.trim());
  const registered = input.tax.gstRegistered;
  const taxableSupply = taxableSupplyInformationRequirements({
    gstRegistered: registered,
    title: common.title,
    supplierName: common.business.name,
    supplierGstNumber: registered ? input.business.gstNumber : null,
    date: input.issueDate,
    recipient: { ...input.customer },
    lines: common.totalsCents.lines.map((line) => ({
      description: line.description,
      quantityMilli: line.quantityMilli,
    })),
    totalInclCents: common.totalsCents.totalInclCents,
    showsGstAmount: registered,
    statesTotalIncludesGst: registered,
    showsExclusiveTotal: registered,
  });
  return {
    ...common,
    kind: 'invoice',
    number: input.invoiceNumber.trim(),
    versionLabel: null,
    dates: [
      { label: 'Invoice date', value: formatDocumentDate(input.issueDate) },
      { label: 'Due', value: formatDocumentDate(input.dueDate) },
    ],
    notes,
    acceptanceNote: null,
    taxableSupply,
  };
}
