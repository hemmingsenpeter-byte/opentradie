import { describe, expect, it } from 'vitest';
import {
  customerNameFromSender,
  draftWarnings,
  isAutomatedEmail,
  looksLikeEnquiry,
  normaliseEmailAddress,
  normaliseSubject,
  parseMessageIds,
  subjectIsThreadable,
} from './inbound-email.js';

describe('inbound email rules', () => {
  it('normalises subjects for weak threading', () => {
    expect(normaliseSubject('RE: Fwd: re[2]:  Power   Points ')).toBe('power points');
    expect(normaliseSubject(null)).toBe('');
    expect(subjectIsThreadable('power points')).toBe(true);
    expect(subjectIsThreadable('quote')).toBe(false);
    expect(subjectIsThreadable('hi')).toBe(false);
  });

  it('validates and lower-cases addresses and parses message id lists', () => {
    expect(normaliseEmailAddress(' Kiri.Walker@Example.TEST ')).toBe('kiri.walker@example.test');
    expect(normaliseEmailAddress('not an address')).toBeNull();
    expect(normaliseEmailAddress('a@b')).toBeNull();
    expect(parseMessageIds('<a@x> junk <b@y> <a@x>')).toEqual(['<a@x>', '<b@y>']);
  });

  it('recognises automated mail', () => {
    expect(isAutomatedEmail({ fromAddress: 'no-reply@x.test' })).toBe(true);
    expect(isAutomatedEmail({ fromAddress: 'mailer-daemon@x.test' })).toBe(true);
    expect(isAutomatedEmail({ fromAddress: 'a@x.test', autoSubmitted: 'auto-replied' })).toBe(true);
    expect(isAutomatedEmail({ fromAddress: 'a@x.test', autoSubmitted: 'no' })).toBe(false);
    expect(isAutomatedEmail({ fromAddress: 'a@x.test', precedence: 'bulk' })).toBe(true);
    expect(isAutomatedEmail({ fromAddress: 'a@x.test', listId: '<list.x.test>' })).toBe(true);
    expect(isAutomatedEmail({ fromAddress: 'noreen@x.test' })).toBe(false);
  });

  it('detects enquiries but never for automated mail', () => {
    expect(looksLikeEnquiry({ subject: 'Quote please', text: '', automated: false })).toBe(true);
    expect(
      looksLikeEnquiry({ subject: '', text: 'my lights keep tripping', automated: false }),
    ).toBe(true);
    expect(looksLikeEnquiry({ subject: 'Hi', text: 'Long time no see', automated: false })).toBe(
      false,
    );
    expect(looksLikeEnquiry({ subject: 'Quote', text: 'install', automated: true })).toBe(false);
  });

  it('flags prices, bank details, links and addresses in drafts', () => {
    expect(draftWarnings('Kia ora, we will be in touch.')).toEqual([]);
    expect(
      draftWarnings(
        'That will be $250 + GST. Pay 12-3456-7890123-00 or see https://x.test, mail a@b.test',
      ),
    ).toEqual([
      'contains_price',
      'contains_bank_account',
      'contains_link',
      'contains_email_address',
    ]);
  });

  it('derives a customer name from the sender', () => {
    expect(customerNameFromSender('"Kiri Walker"', 'kiri@x.test')).toBe('Kiri Walker');
    expect(customerNameFromSender(null, 'kiri.walker99@x.test')).toBe('Kiri Walker');
    expect(customerNameFromSender('kiri@x.test', 'kiri@x.test')).toBe('Kiri');
  });
});
