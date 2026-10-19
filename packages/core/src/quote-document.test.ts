import { describe, expect, it } from 'vitest';
import type { LineInput } from './pricing.js';
import {
  addDays,
  assertIsoDate,
  canTransitionQuote,
  createQuoteDraft,
  expireIfLapsed,
  isQuoteValidityLapsed,
  isTerminalQuoteStatus,
  localDate,
  QUOTE_TRANSITIONS,
  QuoteTransitionError,
  reviseQuote,
  transitionQuote,
  type QuoteDocumentStatus,
} from './quote-document.js';

const line: LineInput = {
  kind: 'labour',
  description: 'Labour',
  unit: 'hour',
  quantityMilli: 1_500,
  price: { source: 'approved_rate', rateCode: 'labour_hour', unitPriceCents: 11_000 },
  taxCode: 'standard',
};
// 2026-10-19 10:00 in Auckland (NZDT, UTC+13).
const now = new Date('2026-10-18T21:00:00Z');
const draft = createQuoteDraft({
  quoteNumber: 'Q-0042',
  lines: [line],
  issueDate: '2026-10-19',
  validityDays: 30,
  terms: 'Payment within 7 days of completion.',
});

describe('quote state machine', () => {
  const all = Object.keys(QUOTE_TRANSITIONS) as QuoteDocumentStatus[];
  it('allows exactly the documented transitions', () => {
    const allowed = all.flatMap((from) =>
      all.filter((to) => canTransitionQuote(from, to)).map((to) => `${from}->${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        'draft->sent',
        'draft->superseded',
        'sent->accepted',
        'sent->rejected',
        'sent->expired',
        'sent->superseded',
      ].sort(),
    );
    expect(all.filter(isTerminalQuoteStatus).sort()).toEqual(
      ['accepted', 'expired', 'rejected', 'superseded'].sort(),
    );
  });
  it('sends, then accepts within validity', () => {
    expect(draft).toMatchObject({ version: 1, status: 'draft', validUntil: '2026-11-18' });
    const sent = transitionQuote(draft, 'sent', now);
    expect(sent).toMatchObject({ status: 'sent', sentAt: now.toISOString() });
    expect(draft.status).toBe('draft'); // not mutated
    const accepted = transitionQuote(sent, 'accepted', new Date('2026-11-18T10:59:59Z'));
    expect(accepted).toMatchObject({ status: 'accepted', decidedAt: '2026-11-18T10:59:59.000Z' });
    expect(() => transitionQuote(accepted, 'rejected', now)).toThrow(QuoteTransitionError);
  });
  it('refuses invalid moves with a typed error', () => {
    for (const to of ['accepted', 'rejected', 'expired'] as const) {
      try {
        transitionQuote(draft, to, now);
        expect.unreachable();
      } catch (error) {
        expect((error as QuoteTransitionError).code).toBe('INVALID_TRANSITION');
      }
    }
    expect(() => transitionQuote({ ...draft, lines: [] }, 'sent', now)).toThrow(/at least one/);
  });
  it('cannot accept or send after validity, and expires only once lapsed', () => {
    const sent = transitionQuote(draft, 'sent', now);
    // 2026-11-19 00:00 NZDT = 2026-11-18T11:00Z: the day after validUntil in Auckland.
    const lapsed = new Date('2026-11-18T11:00:00Z');
    expect(() => transitionQuote(sent, 'accepted', lapsed)).toThrow(/expired/);
    expect(() => transitionQuote(draft, 'sent', lapsed)).toThrow(/validity/);
    expect(() => transitionQuote(sent, 'expired', now)).toThrow(/still within/);
    expect(transitionQuote(sent, 'expired', lapsed).status).toBe('expired');
    expect(expireIfLapsed(sent, now)).toBeNull();
    expect(expireIfLapsed(sent, lapsed)?.status).toBe('expired');
    expect(expireIfLapsed(draft, lapsed)).toBeNull();
    // A rejection after the validity date is still recorded.
    expect(transitionQuote(sent, 'rejected', lapsed).status).toBe('rejected');
  });
});

describe('revisions', () => {
  it('revising a sent quote supersedes it and creates version n+1 in draft', () => {
    const sent = transitionQuote(draft, 'sent', now);
    const { superseded, next } = reviseQuote(sent, {
      lines: [{ ...line, quantityMilli: 2_000 }],
      issueDate: '2026-10-25',
    });
    expect(superseded).toMatchObject({ version: 1, status: 'superseded', supersededByVersion: 2 });
    expect(next).toMatchObject({
      quoteNumber: 'Q-0042',
      version: 2,
      status: 'draft',
      issueDate: '2026-10-25',
      validUntil: '2026-11-24',
      terms: sent.terms,
      sentAt: null,
    });
    expect(next.lines[0]!.quantityMilli).toBe(2_000);
    expect(sent.lines[0]!.quantityMilli).toBe(1_500);
    const third = reviseQuote(next, { issueDate: '2026-10-26', validityDays: 14 }).next;
    expect(third).toMatchObject({ version: 3, validUntil: '2026-11-09' });
    expect(third.lines).toEqual(next.lines);
  });
  it('decided quotes cannot be revised', () => {
    const sent = transitionQuote(draft, 'sent', now);
    for (const decided of [
      transitionQuote(sent, 'accepted', now),
      transitionQuote(sent, 'rejected', now),
      reviseQuote(sent, { issueDate: '2026-10-20' }).superseded,
    ])
      expect(() => reviseQuote(decided, { issueDate: '2026-10-20' })).toThrow(/cannot be revised/);
  });
});

describe('dates', () => {
  it('validates calendar dates and adds days across months and leap years', () => {
    expect(assertIsoDate('2028-02-29')).toBe('2028-02-29');
    for (const bad of ['2026-02-29', '2026-13-01', '2026-1-01', 'tomorrow'])
      expect(() => assertIsoDate(bad)).toThrow(QuoteTransitionError);
    expect(addDays('2026-12-25', 7)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
  it('uses the business time zone for the validity day', () => {
    expect(localDate(new Date('2026-10-18T11:30:00Z'))).toBe('2026-10-19');
    expect(localDate(new Date('2026-10-18T11:30:00Z'), 'UTC')).toBe('2026-10-18');
    expect(isQuoteValidityLapsed('2026-10-18', new Date('2026-10-18T10:59:00Z'))).toBe(false);
    expect(isQuoteValidityLapsed('2026-10-18', new Date('2026-10-18T11:00:00Z'))).toBe(true);
    expect(() => localDate(new Date('nope'))).toThrow();
  });
  it('rejects bad drafts', () => {
    expect(() =>
      createQuoteDraft({ quoteNumber: ' ', lines: [], issueDate: '2026-10-19' }),
    ).toThrow();
    expect(() =>
      createQuoteDraft({
        quoteNumber: 'Q-1',
        lines: [],
        issueDate: '2026-10-19',
        validityDays: 366,
      }),
    ).toThrow();
    expect(
      createQuoteDraft({ quoteNumber: 'Q-1', lines: [], issueDate: '2026-10-19' }).validUntil,
    ).toBe('2026-11-18');
  });
});
