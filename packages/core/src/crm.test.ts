import { describe, expect, it } from 'vitest';
import { evaluateCondition, summariseAutomation, validateAutomation } from './automations.js';
import {
  computeCustomerReport,
  customerReportCsv,
  findDuplicateCandidates,
  nameSimilarity,
  normaliseNzPhone,
  normaliseTagName,
  nzFinancialYear,
  reportPeriod,
  type ReportInvoice,
} from './crm.js';

describe('tag names', () => {
  it('normalises case and whitespace', () => {
    expect(normaliseTagName('  No   Marketing ')).toBe('no marketing');
    expect(normaliseTagName('VIP')).toBe('vip');
  });
});

describe('NZ phone normalisation', () => {
  it('treats +64, 0064, 64 and 0 prefixes and punctuation as the same number', () => {
    const forms = [
      '+64 21 555 0101',
      '021 555 0101',
      '0215550101',
      '0064 21-555-0101',
      '(021) 555.0101',
      '64215550101',
    ];
    expect(new Set(forms.map(normaliseNzPhone))).toEqual(new Set(['215550101']));
  });
  it('keeps other countries distinct and rejects junk', () => {
    expect(normaliseNzPhone('+61 4 1234 5678')).toBe('+61412345678');
    expect(normaliseNzPhone('call me')).toBeNull();
    expect(normaliseNzPhone('123')).toBeNull();
    expect(normaliseNzPhone(null)).toBeNull();
  });
});

describe('name similarity', () => {
  it('ignores case, accents, punctuation and honorifics', () => {
    expect(nameSimilarity('Mrs Margaret Johnson', 'margaret johnson')).toBe(1);
    expect(nameSimilarity('Tāne Mahuta', 'Tane Mahuta')).toBe(1);
  });
  it('allows a one-letter spelling slip in longer names only', () => {
    expect(nameSimilarity('Jon Smithe', 'Jon Smith')).toBe(1);
    expect(nameSimilarity('Al Li', 'Al Lu')).toBe(0.5);
    expect(nameSimilarity('', 'Anyone')).toBe(0);
    expect(nameSimilarity('Helen Johnson', 'Mrs Johnson')).toBe(0.5);
  });
});

describe('duplicate candidates', () => {
  const base = { email: null, phone: null, addresses: [] as string[] };
  it('scores exact email and NZ phone, ordered pairs, highest first', () => {
    const pairs = findDuplicateCandidates([
      {
        ...base,
        id: 'b',
        name: 'Kiri Walker',
        email: 'KIRI@example.test',
        phone: '+64 21 555 0101',
      },
      { ...base, id: 'a', name: 'K Walker', email: 'kiri@example.test ', phone: '021 555 0101' },
      { ...base, id: 'c', name: 'Someone Else', phone: '021 555 0101' },
    ]);
    expect(pairs[0]).toEqual({ a: 'a', b: 'b', score: 100, reasons: ['email', 'phone'] });
    expect(pairs.map((p) => `${p.a}${p.b}`)).toEqual(['ab', 'ac', 'bc']);
  });
  it('needs a shared address for a name match, and ignores a name alone', () => {
    expect(
      findDuplicateCandidates([
        { ...base, id: 'a', name: 'Helen Johnson', addresses: ['12 Kauri Street, Hamilton'] },
        { ...base, id: 'b', name: 'helen johnson', addresses: ['12 kauri st hamilton'] },
        { ...base, id: 'c', name: 'Helen Johnson', addresses: ['4 Other Road'] },
      ]),
    ).toEqual([{ a: 'a', b: 'b', score: 40, reasons: ['name_and_address'] }]);
  });
});

describe('report periods', () => {
  it('uses the NZ financial year (1 April to 31 March)', () => {
    expect(nzFinancialYear('2026-03-31')).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(nzFinancialYear('2026-04-01')).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    expect(reportPeriod('this_financial_year', '2026-10-24')).toEqual({
      from: '2026-04-01',
      to: '2027-03-31',
    });
  });
  it('handles month presets across year ends and leap years', () => {
    expect(reportPeriod('last_month', '2026-01-15')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
    expect(reportPeriod('this_month', '2028-02-10')).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });
});

describe('customer report maths', () => {
  const invoice = (over: Partial<ReportInvoice>): ReportInvoice => ({
    customerId: 'a',
    status: 'posted',
    issueDate: '2026-05-01',
    subtotalCents: 10_000,
    taxCents: 1_500,
    totalCents: 11_500,
    paidCents: 0,
    paidDate: null,
    ...over,
  });
  const report = computeCustomerReport({
    range: { from: '2026-04-01', to: '2027-03-31' },
    customers: [
      { id: 'a', name: 'Aroha', createdAt: '2025-01-01' },
      { id: 'b', name: 'Ben', createdAt: '2026-06-01' },
      { id: 'c', name: 'Idle', createdAt: '2020-01-01' },
    ],
    jobs: [
      { customerId: 'a', date: '2026-03-31' },
      { customerId: 'a', date: '2026-04-01' },
      { customerId: 'b', date: '2026-06-02' },
    ],
    quotes: [
      { customerId: 'a', status: 'accepted', sentDate: '2026-04-02' },
      { customerId: 'a', status: 'declined', sentDate: '2026-04-03' },
      { customerId: 'b', status: 'accepted', sentDate: '2026-06-03' },
      { customerId: 'b', status: 'sent', sentDate: '2026-03-30' },
    ],
    invoices: [
      invoice({ paidCents: 11_500, paidDate: '2026-05-11', status: 'paid' }),
      invoice({ status: 'part_paid', paidCents: 5_000 }),
      invoice({ status: 'draft' }),
      invoice({ status: 'void' }),
      invoice({ issueDate: '2027-04-01' }),
      invoice({
        customerId: 'b',
        subtotalCents: 20_000,
        taxCents: 3_000,
        totalCents: 23_000,
        paidCents: 23_000,
        paidDate: '2026-06-05',
        issueDate: '2026-06-02',
      }),
    ],
  });
  it('counts only approved-or-later, non-void invoices in the period, in cents', () => {
    const aroha = report.rows.find((row) => row.customerId === 'a')!;
    expect(aroha).toMatchObject({
      jobs: 1,
      quotesSent: 2,
      quotesAccepted: 1,
      winRateBp: 5000,
      invoicedExclCents: 20_000,
      invoicedGstCents: 3_000,
      invoicedInclCents: 23_000,
      paidCents: 16_500,
      outstandingCents: 6_500,
      firstJobDate: '2026-03-31',
      repeat: true,
    });
    expect(report.rows.map((row) => row.customerId)).toEqual(['a', 'b']);
  });
  it('summarises new vs repeat, win rate, top customers and days to pay', () => {
    expect(report.summary).toMatchObject({
      customers: 2,
      newCustomers: 1,
      repeatCustomers: 1,
      quotesSent: 3,
      quotesAccepted: 2,
      winRateBp: 6667,
      invoicedInclCents: 46_000,
      paidCents: 39_500,
      outstandingCents: 6_500,
      averageDaysToPay: 7,
    });
    expect(report.summary.topCustomers.map((row) => row.customerId)).toEqual(['a', 'b']);
  });
  it('renders CSV in dollars and neutralises spreadsheet formulas', () => {
    const csv = customerReportCsv({
      ...report,
      rows: [{ ...report.rows[0]!, name: '=HYPERLINK("x")' }],
    });
    expect(csv.split('\r\n')[1]).toBe(
      `"'=HYPERLINK(""x"")",1,2,1,50.00,200.00,30.00,230.00,165.00,65.00,2026-03-31,2026-04-01,yes`,
    );
  });
});

describe('customer.tags automation fact', () => {
  const definition = (op: string, value?: string) => ({
    name: 'Tagged',
    trigger: {
      event: 'job.completed',
      filter:
        value === undefined
          ? { field: 'customer.tags', op }
          : { field: 'customer.tags', op, value },
    },
    actions: [{ tool: 'task.create', title: 'Call' }],
  });
  it('validates: only contains / not_contains / exists, with a text value', () => {
    expect(validateAutomation(definition('contains', 'vip')).ok).toBe(true);
    expect(validateAutomation(definition('eq', 'vip')).ok).toBe(false);
    expect(validateAutomation(definition('contains')).ok).toBe(false);
  });
  it('tests whole-tag membership, case-insensitively', () => {
    const facts = { 'customer.tags': ['vip', 'no-marketing'] };
    expect(evaluateCondition({ field: 'customer.tags', op: 'contains', value: 'VIP' }, facts)).toBe(
      true,
    );
    expect(evaluateCondition({ field: 'customer.tags', op: 'contains', value: 'vi' }, facts)).toBe(
      false,
    );
    expect(
      evaluateCondition(
        { field: 'customer.tags', op: 'not_contains', value: 'no-marketing' },
        facts,
      ),
    ).toBe(false);
    expect(evaluateCondition({ field: 'customer.tags', op: 'not_contains', value: 'x' }, {})).toBe(
      true,
    );
    expect(
      evaluateCondition({ field: 'customer.tags', op: 'exists' }, { 'customer.tags': [] }),
    ).toBe(false);
  });
  it('summarises in plain English', () => {
    const validated = validateAutomation(definition('not_contains', 'No-Marketing'));
    expect(validated.ok && validated.summary).toContain(
      'the customer is not tagged "no-marketing"',
    );
    expect(validated.ok && summariseAutomation(validated.definition)).toContain('not tagged');
  });
});
