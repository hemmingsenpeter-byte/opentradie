/**
 * New Zealand taxable supply information (TSI) checks.
 *
 * Source: Goods and Services Tax Act 1985 ss 19F–19N (inserted by the Taxation (Annual Rates
 * for 2022–23, Platform Economy, and Remedial Matters) Act 2023), in force from 1 April 2023;
 * Inland Revenue guidance "Taxable supply information" (ird.govt.nz) and Tax Information
 * Bulletin Vol 35 No 4 (May 2023). Thresholds are on the GST-inclusive consideration:
 *
 *   ≤ $200            no TSI required.
 *   > $200 ≤ $1,000   supplier name (or trade name); supplier GST registration number;
 *                     date of the invoice or time of supply; description of the goods and
 *                     services; total amount payable; and either the GST amount or a
 *                     statement that the total includes GST.
 *   > $1,000          all of the above, plus recipient name and at least one identifier
 *                     (address, phone number, email address, NZBN, trading name or website);
 *                     quantity or volume of the goods and services; and the GST amount, shown
 *                     either with the GST-exclusive and GST-inclusive totals or with the
 *                     GST-inclusive total and a statement that it includes GST.
 *
 * Since 1 April 2023 the document no longer has to be titled "tax invoice". OPENTRADIE chooses
 * to call a GST-registered business's invoices "Tax invoice" and anything from a business that
 * is not registered "Invoice", which must not show GST or a GST number. Quotes are offers, not
 * supplies: they are titled "Quote" and are never tax invoices.
 *
 * This is product logic encoding public guidance, not tax advice; owners should confirm with
 * their accountant.
 */

export const TSI_LOW_VALUE_LIMIT_CENTS = 20_000; // $200.00 inclusive
export const TSI_HIGH_VALUE_LIMIT_CENTS = 100_000; // $1,000.00 inclusive

export type DocumentKind = 'quote' | 'invoice';

export function documentTitle(kind: DocumentKind, gstRegistered: boolean): string {
  if (kind === 'quote') return 'Quote';
  return gstRegistered ? 'Tax invoice' : 'Invoice';
}

export type TsiTier = 'not_registered' | 'none' | 'up_to_1000' | 'over_1000';

/** Classify by the GST-inclusive total. Exactly $200.00 → none; exactly $1,000.00 → up_to_1000. */
export function taxableSupplyTier(totalInclCents: number, gstRegistered: boolean): TsiTier {
  if (!Number.isSafeInteger(totalInclCents) || totalInclCents < 0)
    throw new RangeError('total must be non-negative whole cents.');
  if (!gstRegistered) return 'not_registered';
  if (totalInclCents <= TSI_LOW_VALUE_LIMIT_CENTS) return 'none';
  if (totalInclCents <= TSI_HIGH_VALUE_LIMIT_CENTS) return 'up_to_1000';
  return 'over_1000';
}

/** What an invoice document will actually show. Absent or blank strings count as missing. */
export interface TaxableSupplyDocument {
  gstRegistered: boolean;
  title: string;
  supplierName?: string | null;
  supplierGstNumber?: string | null;
  /** Invoice date or time of supply, YYYY-MM-DD. */
  date?: string | null;
  recipient?: {
    name?: string | null;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
    nzbn?: string | null;
    tradingName?: string | null;
    website?: string | null;
  } | null;
  lines: readonly { description?: string | null; quantityMilli?: number | null }[];
  totalInclCents: number;
  /** True when the document prints the GST amount. */
  showsGstAmount: boolean;
  /** True when the document states that the total includes GST. */
  statesTotalIncludesGst: boolean;
  /** True when the document also prints the GST-exclusive total (subtotal). */
  showsExclusiveTotal?: boolean;
}

export interface TsiCheck {
  tier: TsiTier;
  /** Required information the document lacks. Empty means compliant for its tier. */
  missing: string[];
  /** Things the document must not show (e.g. GST on a non-registered business's invoice). */
  problems: string[];
}

const present = (value: string | null | undefined): boolean =>
  typeof value === 'string' && value.trim().length > 0;

/** GST numbers are 8 or 9 digits, optionally formatted 123-456-789. Format check only. */
export function isPlausibleGstNumber(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '');
  return /^\d{8,9}$/.test(digits);
}

export function taxableSupplyInformationRequirements(doc: TaxableSupplyDocument): TsiCheck {
  const tier = taxableSupplyTier(doc.totalInclCents, doc.gstRegistered);
  const missing: string[] = [];
  const problems: string[] = [];

  if (!doc.gstRegistered) {
    if (/tax invoice/i.test(doc.title))
      problems.push('A business that is not GST-registered must not issue a "Tax invoice".');
    if (doc.showsGstAmount || doc.statesTotalIncludesGst)
      problems.push('A business that is not GST-registered must not show or claim GST.');
    if (present(doc.supplierGstNumber))
      problems.push('A business that is not GST-registered must not show a GST number.');
    return { tier, missing, problems };
  }

  if (present(doc.supplierGstNumber) && !isPlausibleGstNumber(doc.supplierGstNumber!))
    problems.push('Supplier GST number is not 8 or 9 digits.');
  if (tier === 'none') return { tier, missing, problems };

  if (!present(doc.supplierName)) missing.push('supplier name');
  if (!present(doc.supplierGstNumber)) missing.push('supplier GST number');
  if (!present(doc.date)) missing.push('date of invoice or time of supply');
  if (doc.lines.length === 0 || doc.lines.some((line) => !present(line.description)))
    missing.push('description of the goods and services');

  if (tier === 'up_to_1000') {
    if (!doc.showsGstAmount && !doc.statesTotalIncludesGst)
      missing.push('GST amount or a statement that the total includes GST');
    return { tier, missing, problems };
  }

  const recipient = doc.recipient ?? {};
  if (!present(recipient.name)) missing.push('recipient name');
  const identifiers = [
    recipient.address,
    recipient.phone,
    recipient.email,
    recipient.nzbn,
    recipient.tradingName,
    recipient.website,
  ];
  if (!identifiers.some(present))
    missing.push('recipient identifier (address, phone, email, NZBN, trading name or website)');
  if (
    doc.lines.some(
      (line) =>
        line.quantityMilli === null ||
        line.quantityMilli === undefined ||
        !Number.isSafeInteger(line.quantityMilli) ||
        line.quantityMilli <= 0,
    )
  )
    missing.push('quantity or volume of the goods and services');
  if (!doc.showsGstAmount) missing.push('GST amount');
  if (!doc.statesTotalIncludesGst && !doc.showsExclusiveTotal)
    missing.push('GST-exclusive total, or a statement that the total includes GST');
  return { tier, missing, problems };
}
