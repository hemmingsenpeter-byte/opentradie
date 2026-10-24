/**
 * CRM helpers for a sole tradie (ADR 0034): tag names, duplicate scoring and customer report
 * maths. Pure and deterministic; money is integer cents.
 */

// ------------------------------------------------------------------ tags

/** Tags are stored lower-case and trimmed with single spaces, so "VIP " and "vip" are one tag. */
export function normaliseTagName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-NZ');
}

// ------------------------------------------------------------------ duplicate detection

export interface DuplicateInput {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Customer address plus property address lines. */
  addresses: readonly string[];
}

export type DuplicateReason = 'email' | 'phone' | 'name_and_address' | 'similar_name';

export interface DuplicatePair {
  /** The two ids, ordered so a < b. */
  a: string;
  b: string;
  score: number;
  reasons: DuplicateReason[];
}

export function normaliseEmail(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase();
  return value && value.includes('@') ? value : null;
}

/**
 * NZ phone numbers compare as national digits: spaces, dashes, brackets and dots are dropped,
 * and +64 / 0064 / 64 / a leading 0 are the same prefix ("+64 21 555 0101" = "021 5550101").
 */
export function normaliseNzPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  if (digits.startsWith('+64')) digits = digits.slice(3);
  else if (digits.startsWith('0064')) digits = digits.slice(4);
  else if (digits.startsWith('+')) return digits;
  else if (digits.startsWith('64') && digits.length >= 10) digits = digits.slice(2);
  digits = digits.replace(/^0+/, '');
  return digits.length >= 7 ? digits : null;
}

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr']);

export function normaliseName(name: string): string {
  return name
    .toLocaleLowerCase('en-NZ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token && !HONORIFICS.has(token))
    .join(' ');
}

export function normaliseAddress(address: string): string {
  return address
    .toLocaleLowerCase('en-NZ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(street)\b/g, 'st')
    .replace(/\b(road)\b/g, 'rd')
    .replace(/\b(avenue)\b/g, 'ave')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
}

/** Name similarity 0..1: token overlap, with near-identical spellings counting as a match. */
export function nameSimilarity(left: string, right: string): number {
  const a = normaliseName(left);
  const b = normaliseName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const tokensA = a.split(' ');
  const tokensB = b.split(' ');
  const close = (x: string, y: string) =>
    x === y || (Math.min(x.length, y.length) >= 4 && levenshtein(x, y) <= 1);
  const matched = tokensA.filter((x) => tokensB.some((y) => close(x, y))).length;
  return matched / Math.max(tokensA.length, tokensB.length);
}

/**
 * Candidate duplicate pairs with reasons and a 0-100 score. Exact normalised email or phone
 * is strong evidence; a similar name alone is weak and only reported with a shared address.
 */
export function findDuplicateCandidates(customers: readonly DuplicateInput[]): DuplicatePair[] {
  const prepared = customers.map((customer) => ({
    id: customer.id,
    name: customer.name,
    email: normaliseEmail(customer.email),
    phone: normaliseNzPhone(customer.phone),
    addresses: new Set(customer.addresses.map(normaliseAddress).filter(Boolean)),
  }));
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < prepared.length; i++)
    for (let j = i + 1; j < prepared.length; j++) {
      const x = prepared[i]!;
      const y = prepared[j]!;
      const reasons: DuplicateReason[] = [];
      let score = 0;
      if (x.email && x.email === y.email) {
        reasons.push('email');
        score += 60;
      }
      if (x.phone && x.phone === y.phone) {
        reasons.push('phone');
        score += 50;
      }
      const similarity = nameSimilarity(x.name, y.name);
      const sharedAddress = [...x.addresses].some((address) => y.addresses.has(address));
      if (similarity >= 0.5 && sharedAddress) {
        reasons.push('name_and_address');
        score += 40;
      } else if (similarity >= 0.99 && reasons.length) {
        reasons.push('similar_name');
        score += 10;
      }
      if (!reasons.length) continue;
      const [a, b] = x.id < y.id ? [x.id, y.id] : [y.id, x.id];
      pairs.push({ a, b, score: Math.min(100, score), reasons });
    }
  return pairs.sort(
    (p, q) => q.score - p.score || p.a.localeCompare(q.a) || p.b.localeCompare(q.b),
  );
}

// ------------------------------------------------------------------ reports

export interface DateRange {
  /** Inclusive, YYYY-MM-DD. */
  from: string;
  /** Inclusive, YYYY-MM-DD. */
  to: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The NZ financial year (1 April – 31 March) containing the given calendar date. */
export function nzFinancialYear(date: string): DateRange {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return { from: ymd(start, 4, 1), to: ymd(start + 1, 3, 31) };
}

export type ReportPeriod = 'this_month' | 'last_month' | 'this_financial_year';

/** Period presets for a calendar date in the business's time zone (YYYY-MM-DD). */
export function reportPeriod(period: ReportPeriod, today: string): DateRange {
  const [y, m] = today.split('-').map(Number) as [number, number];
  if (period === 'this_month') return { from: ymd(y, m, 1), to: ymd(y, m, lastDay(y, m)) };
  if (period === 'last_month') {
    const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
    return { from: ymd(py, pm, 1), to: ymd(py, pm, lastDay(py, pm)) };
  }
  return nzFinancialYear(today);
}

/**
 * Invoice statuses that count as revenue: an approved invoice is a committed charge whether or
 * not it has reached the accounting system. Drafts are not yet charged; void invoices never were.
 */
export const REVENUE_INVOICE_STATUSES = [
  'approved',
  'posting',
  'posted',
  'sync_failed',
  'part_paid',
  'paid',
] as const;

export interface ReportCustomer {
  id: string;
  name: string;
  createdAt: string;
}
export interface ReportJob {
  customerId: string;
  /** YYYY-MM-DD */
  date: string;
}
export interface ReportQuote {
  customerId: string;
  status: string;
  /** YYYY-MM-DD or null when never sent. */
  sentDate: string | null;
}
export interface ReportInvoice {
  customerId: string;
  status: string;
  /** YYYY-MM-DD */
  issueDate: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Paid so far per the latest payment snapshot (or the total when status is paid). */
  paidCents: number;
  /** YYYY-MM-DD the invoice was first seen fully paid, if it has been. */
  paidDate: string | null;
}

export interface CustomerReportRow {
  customerId: string;
  name: string;
  jobs: number;
  quotesSent: number;
  quotesAccepted: number;
  /** Basis points (0-10000); null when no quotes were sent. */
  winRateBp: number | null;
  invoicedExclCents: number;
  invoicedGstCents: number;
  invoicedInclCents: number;
  paidCents: number;
  outstandingCents: number;
  firstJobDate: string | null;
  lastJobDate: string | null;
  repeat: boolean;
}

export interface CustomerReport {
  range: DateRange;
  rows: CustomerReportRow[];
  summary: {
    customers: number;
    newCustomers: number;
    repeatCustomers: number;
    quotesSent: number;
    quotesAccepted: number;
    winRateBp: number | null;
    invoicedExclCents: number;
    invoicedGstCents: number;
    invoicedInclCents: number;
    paidCents: number;
    outstandingCents: number;
    /** Whole days, rounded half up; null when nothing in the period was fully paid. */
    averageDaysToPay: number | null;
    topCustomers: { customerId: string; name: string; invoicedInclCents: number }[];
  };
}

const within = (date: string | null, range: DateRange) =>
  date !== null && date >= range.from && date <= range.to;
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const bp = (part: number, whole: number) =>
  whole ? Math.floor((part * 10_000 + Math.floor(whole / 2)) / whole) : null;

/**
 * Per-customer activity in the period. A repeat customer has jobs on two or more distinct days
 * up to the end of the period; a new customer's first ever job falls inside the period.
 * Customers with no activity in the period are left out.
 */
export function computeCustomerReport(input: {
  range: DateRange;
  customers: readonly ReportCustomer[];
  jobs: readonly ReportJob[];
  quotes: readonly ReportQuote[];
  invoices: readonly ReportInvoice[];
  top?: number;
}): CustomerReport {
  const { range } = input;
  const revenue = new Set<string>(REVENUE_INVOICE_STATUSES);
  const rows: CustomerReportRow[] = [];
  let paidDays = 0;
  let paidCount = 0;
  let newCustomers = 0;
  for (const customer of [...input.customers].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  )) {
    const allJobs = input.jobs
      .filter((job) => job.customerId === customer.id && job.date <= range.to)
      .map((job) => job.date)
      .sort();
    const periodJobs = allJobs.filter((date) => date >= range.from);
    const sent = input.quotes.filter(
      (quote) => quote.customerId === customer.id && within(quote.sentDate, range),
    );
    const accepted = sent.filter((quote) => quote.status === 'accepted').length;
    const invoices = input.invoices.filter(
      (invoice) =>
        invoice.customerId === customer.id &&
        revenue.has(invoice.status) &&
        within(invoice.issueDate, range),
    );
    if (!periodJobs.length && !sent.length && !invoices.length) continue;
    let excl = 0;
    let gst = 0;
    let incl = 0;
    let paid = 0;
    for (const invoice of invoices) {
      excl += invoice.subtotalCents;
      gst += invoice.taxCents;
      incl += invoice.totalCents;
      paid += Math.min(invoice.paidCents, invoice.totalCents);
      if (invoice.paidDate && invoice.paidCents >= invoice.totalCents) {
        paidDays += Math.max(0, days(invoice.issueDate, invoice.paidDate));
        paidCount++;
      }
    }
    if (allJobs[0] !== undefined && allJobs[0] >= range.from) newCustomers++;
    rows.push({
      customerId: customer.id,
      name: customer.name,
      jobs: periodJobs.length,
      quotesSent: sent.length,
      quotesAccepted: accepted,
      winRateBp: bp(accepted, sent.length),
      invoicedExclCents: excl,
      invoicedGstCents: gst,
      invoicedInclCents: incl,
      paidCents: paid,
      outstandingCents: incl - paid,
      firstJobDate: allJobs[0] ?? null,
      lastJobDate: allJobs.at(-1) ?? null,
      repeat: new Set(allJobs).size >= 2,
    });
  }
  const sum = (key: keyof CustomerReportRow) =>
    rows.reduce((total, row) => total + (row[key] as number), 0);
  const quotesSent = sum('quotesSent');
  const quotesAccepted = sum('quotesAccepted');
  return {
    range,
    rows,
    summary: {
      customers: rows.length,
      newCustomers,
      repeatCustomers: rows.filter((row) => row.repeat).length,
      quotesSent,
      quotesAccepted,
      winRateBp: bp(quotesAccepted, quotesSent),
      invoicedExclCents: sum('invoicedExclCents'),
      invoicedGstCents: sum('invoicedGstCents'),
      invoicedInclCents: sum('invoicedInclCents'),
      paidCents: sum('paidCents'),
      outstandingCents: sum('outstandingCents'),
      averageDaysToPay: paidCount ? Math.floor((paidDays * 2 + paidCount) / (paidCount * 2)) : null,
      topCustomers: rows
        .filter((row) => row.invoicedInclCents > 0)
        .sort((a, b) => b.invoicedInclCents - a.invoicedInclCents || a.name.localeCompare(b.name))
        .slice(0, input.top ?? 5)
        .map((row) => ({
          customerId: row.customerId,
          name: row.name,
          invoicedInclCents: row.invoicedInclCents,
        })),
    },
  };
}

const csvCell = (value: string | number | boolean | null) => {
  const text = value === null ? '' : String(value);
  // Leading = + - @ would be read as a formula by spreadsheet apps.
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value === 'string' ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const dollars = (cents: number) => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${pad(abs % 100)}`;
};

/** The report as CSV (dollars with two decimals, computed from integer cents). */
export function customerReportCsv(report: CustomerReport): string {
  const header = [
    'Customer',
    'Jobs',
    'Quotes sent',
    'Quotes accepted',
    'Win rate %',
    'Invoiced excl GST',
    'GST',
    'Invoiced incl GST',
    'Paid',
    'Outstanding',
    'First job',
    'Last job',
    'Repeat customer',
  ];
  const lines = report.rows.map((row) =>
    [
      row.name,
      row.jobs,
      row.quotesSent,
      row.quotesAccepted,
      row.winRateBp === null ? null : dollars(row.winRateBp),
      dollars(row.invoicedExclCents),
      dollars(row.invoicedGstCents),
      dollars(row.invoicedInclCents),
      dollars(row.paidCents),
      dollars(row.outstandingCents),
      row.firstJobDate,
      row.lastJobDate,
      row.repeat ? 'yes' : 'no',
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}
