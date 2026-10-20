import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLLECTIONS_POLICY,
  collectionsPolicyErrors,
  daysOverdue,
  decideCollectionStage,
  followUpEmail,
  type CollectionsInvoice,
  type CollectionsPolicy,
} from './collections.js';

const policy: CollectionsPolicy = { ...DEFAULT_COLLECTIONS_POLICY, enabled: true };
const invoice = (over: Partial<CollectionsInvoice> = {}): CollectionsInvoice => ({
  status: 'posted',
  dueDate: '2026-03-01',
  totalCents: 115_000,
  snapshotAmountDueCents: null,
  snapshotProviderStatus: null,
  onHold: false,
  customerErased: false,
  preparedStages: [],
  ...over,
});
// 2026-03-08 00:30 NZDT is 2026-03-07 11:30Z.
const nz = (iso: string) => new Date(iso);

describe('collections stage decision', () => {
  it('is off by default and suppressed while disabled', () => {
    expect(DEFAULT_COLLECTIONS_POLICY.enabled).toBe(false);
    expect(Object.values(DEFAULT_COLLECTIONS_POLICY.autoSend).every((v) => !v)).toBe(true);
    expect(
      decideCollectionStage(invoice(), DEFAULT_COLLECTIONS_POLICY, nz('2026-04-01T00:00:00Z')),
    ).toMatchObject({ stage: 'none', reason: 'disabled' });
  });

  it('counts calendar days in the business time zone at the boundaries', () => {
    // 23:59 local on day 6 is still overdue by 6; 00:00 local on day 7 is stage 1.
    expect(daysOverdue('2026-03-01', nz('2026-03-07T10:59:00Z'), 'Pacific/Auckland')).toBe(6);
    expect(decideCollectionStage(invoice(), policy, nz('2026-03-07T10:59:00Z'))).toMatchObject({
      stage: 'none',
      reason: 'not_due',
      daysOverdue: 6,
    });
    expect(decideCollectionStage(invoice(), policy, nz('2026-03-07T11:00:00Z'))).toMatchObject({
      stage: 'overdue_1',
      daysOverdue: 7,
      amountDueCents: 115_000,
    });
  });

  it('is unaffected by the DST change (NZDT ends 2026-04-05)', () => {
    const due = invoice({ dueDate: '2026-03-29' });
    // 2026-04-05 00:30 NZDT = 2026-04-04T11:30Z; 2026-04-06 00:30 NZST = 2026-04-05T12:30Z.
    expect(daysOverdue(due.dueDate, nz('2026-04-04T11:30:00Z'), 'Pacific/Auckland')).toBe(7);
    expect(daysOverdue(due.dueDate, nz('2026-04-05T11:30:00Z'), 'Pacific/Auckland')).toBe(7);
    expect(daysOverdue(due.dueDate, nz('2026-04-05T12:30:00Z'), 'Pacific/Auckland')).toBe(8);
    // Spring forward (2026-09-27): 00:30 NZDT on 2026-09-28 is 2026-09-27T11:30Z.
    expect(daysOverdue('2026-09-21', nz('2026-09-27T11:30:00Z'), 'Pacific/Auckland')).toBe(7);
  });

  it('picks the latest stage reached', () => {
    const at = (iso: string) => decideCollectionStage(invoice(), policy, nz(iso)).stage;
    expect(at('2026-03-15T00:00:00Z')).toBe('overdue_2');
    expect(at('2026-03-31T00:00:00Z')).toBe('overdue_final');
    expect(at('2026-04-15T00:00:00Z')).toBe('escalate_owner');
  });

  it('offers the courtesy note only when enabled and before the due date', () => {
    const before = nz('2026-02-26T12:00:00Z'); // 27 Feb local: 2 days before due
    expect(decideCollectionStage(invoice(), policy, before)).toMatchObject({ reason: 'not_due' });
    expect(
      decideCollectionStage(invoice(), { ...policy, preDueCourtesyEnabled: true }, before).stage,
    ).toBe('pre_due_courtesy');
    // On the due date itself: no courtesy and no overdue stage.
    expect(
      decideCollectionStage(
        invoice(),
        { ...policy, preDueCourtesyEnabled: true },
        nz('2026-03-01T00:00:00Z'),
      ).stage,
    ).toBe('none');
  });

  it.each([
    [{ status: 'paid' }, 'paid'],
    [{ snapshotProviderStatus: 'paid' }, 'paid'],
    [{ status: 'void' }, 'void'],
    [{ status: 'approved' }, 'not_posted'],
    [{ status: 'draft' }, 'not_posted'],
    [{ status: 'part_paid', snapshotAmountDueCents: 0 }, 'nothing_due'],
    [{ onHold: true }, 'on_hold'],
    [{ customerErased: true }, 'customer_erased'],
    [{ preparedStages: ['overdue_1'] }, 'already_prepared'],
  ] as const)('suppresses %o as %s', (over, reason) => {
    expect(
      decideCollectionStage(
        invoice(over as Partial<CollectionsInvoice>),
        policy,
        nz('2026-03-09T00:00:00Z'),
      ),
    ).toMatchObject({ stage: 'none', reason });
  });

  it('uses the latest provider snapshot for the amount due on part-paid invoices', () => {
    expect(
      decideCollectionStage(
        invoice({ status: 'part_paid', snapshotAmountDueCents: 40_050 }),
        policy,
        nz('2026-03-09T00:00:00Z'),
      ),
    ).toMatchObject({ stage: 'overdue_1', amountDueCents: 40_050 });
  });

  it('validates offsets', () => {
    expect(collectionsPolicyErrors(policy)).toEqual([]);
    expect(collectionsPolicyErrors({ ...policy, overdue2Days: 7 })).not.toEqual([]);
    expect(collectionsPolicyErrors({ ...policy, overdue1Days: 0 })).not.toEqual([]);
  });

  it('renders a deterministic template from integer cents', () => {
    const email = followUpEmail({
      stage: 'overdue_1',
      customerName: 'Ana',
      businessName: 'Kauri Electrical',
      invoiceNumber: 'INV-0007',
      amountDueCents: 123_456,
      currency: 'NZD',
      dueDate: '2026-03-01',
      daysOverdue: 8,
    });
    expect(email.subject).toBe('Reminder: invoice INV-0007 is overdue');
    expect(email.text).toContain('$1,234.56');
    expect(email.text).toContain('1 March 2026');
    expect(email.text).toContain('8 days overdue');
    expect(email.text).toMatch(/^Kia ora Ana,/);
  });
});
