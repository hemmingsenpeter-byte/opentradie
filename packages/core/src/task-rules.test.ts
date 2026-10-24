import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_RULE_SETTINGS as S,
  evaluateTaskRules,
  taskBucket,
  taskSettingsErrors,
  type TaskFacts,
} from './task-rules.js';

const TZ = 'Pacific/Auckland';
const empty = (): TaskFacts => ({
  acceptedQuotes: [],
  sentQuotes: [],
  threads: [],
  completedJobs: [],
  owedInvoices: [],
});
const chase = { overdueFinalDays: 30 };
// 2026-10-24 10:00 NZDT (UTC+13).
const NOW = new Date('2026-10-23T21:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const H = 3_600_000;

describe('task rules', () => {
  it('book_job for an accepted quote until a future appointment exists', () => {
    const facts = empty();
    const quote = {
      quoteId: 'q1',
      jobId: 'j1',
      customerId: 'c1',
      jobTitle: 'Power points',
      quoteNumber: 'Q-1',
      acceptedAt: ago(H),
      appointmentEndsAt: [ago(1)],
    };
    facts.acceptedQuotes.push(quote);
    const [task] = evaluateTaskRules(facts, S, chase, NOW, TZ);
    expect(task).toMatchObject({
      ruleKey: 'book_job',
      dedupeKey: 'book_job:quote:q1',
      priority: 'high',
      links: { jobId: 'j1', quoteId: 'q1', customerId: 'c1' },
    });
    quote.appointmentEndsAt.push(new Date(NOW.getTime() + 1).toISOString());
    expect(evaluateTaskRules(facts, S, chase, NOW, TZ)).toEqual([]);
  });

  it('follow_up_quote at exactly N days, not a millisecond before', () => {
    const facts = empty();
    const sent = {
      quoteId: 'q2',
      jobId: 'j2',
      customerId: 'c2',
      customerName: 'Bob',
      quoteNumber: 'Q-2',
      sentAt: ago(3 * 24 * H - 1),
    };
    facts.sentQuotes.push(sent);
    expect(evaluateTaskRules(facts, S, chase, NOW, TZ)).toEqual([]);
    sent.sentAt = ago(3 * 24 * H);
    expect(evaluateTaskRules(facts, S, chase, NOW, TZ)[0]).toMatchObject({
      kind: 'follow_up_quote',
      title: 'Follow up quote Q-2 with Bob',
      dueAt: NOW.toISOString(),
    });
    expect(evaluateTaskRules(facts, { ...S, followUpQuoteDays: 4 }, chase, NOW, TZ)).toEqual([]);
  });

  it('reply_message after 24 h unless a reply went out; keyed by message', () => {
    const facts = empty();
    const thread = {
      threadId: 't1',
      customerId: null,
      jobId: null,
      senderLabel: 'ann@example.test',
      lastInboundId: 'm1',
      lastInboundAt: ago(24 * H - 1),
      repliedAfter: false,
    };
    facts.threads.push(thread);
    expect(evaluateTaskRules(facts, S, chase, NOW, TZ)).toEqual([]);
    thread.lastInboundAt = ago(24 * H);
    expect(evaluateTaskRules(facts, S, chase, NOW, TZ)[0]?.dedupeKey).toBe(
      'reply_message:message:m1',
    );
    thread.repliedAfter = true;
    expect(evaluateTaskRules(facts, S, chase, NOW, TZ)).toEqual([]);
  });

  it('invoice_job one day after completion when no invoice references the job', () => {
    const facts = empty();
    const job = {
      jobId: 'j3',
      customerId: 'c3',
      jobTitle: 'Heat pump',
      completedAt: ago(24 * H - 1),
      invoiced: false,
    };
    facts.completedJobs.push(job);
    expect(evaluateTaskRules(facts, S, chase, NOW, TZ)).toEqual([]);
    job.completedAt = ago(24 * H);
    expect(evaluateTaskRules(facts, S, chase, NOW, TZ)[0]?.kind).toBe('invoice_job');
    job.invoiced = true;
    expect(evaluateTaskRules(facts, S, chase, NOW, TZ)).toEqual([]);
  });

  it('chase_payment when escalated or overdue beyond the final stage (local days), not on hold', () => {
    const facts = empty();
    const invoice = {
      invoiceId: 'i1',
      jobId: 'j4',
      customerId: 'c4',
      customerName: 'Cara',
      invoiceNumber: 'INV-1',
      // NZ local today is 2026-10-24; 30 days before is 2026-09-24.
      dueDate: '2026-09-24',
      onHold: false,
      escalated: false,
    };
    facts.owedInvoices.push(invoice);
    expect(evaluateTaskRules(facts, S, chase, NOW, TZ)).toEqual([]);
    invoice.dueDate = '2026-09-23';
    const [task] = evaluateTaskRules(facts, S, chase, NOW, TZ);
    expect(task).toMatchObject({ kind: 'chase_payment', priority: 'high' });
    expect(task!.dueAt).toBe('2026-10-23T20:00:00.000Z'); // 9:00 NZDT on 2026-10-24
    invoice.onHold = true;
    expect(evaluateTaskRules(facts, S, chase, NOW, TZ)).toEqual([]);
    invoice.onHold = false;
    invoice.dueDate = '2026-10-20';
    invoice.escalated = true;
    expect(evaluateTaskRules(facts, S, chase, NOW, TZ)).toHaveLength(1);
  });

  it('produces nothing when rules are switched off and validates settings', () => {
    const facts = empty();
    facts.completedJobs.push({
      jobId: 'j',
      customerId: 'c',
      jobTitle: 't',
      completedAt: ago(48 * H),
      invoiced: false,
    });
    expect(evaluateTaskRules(facts, { ...S, rulesEnabled: false }, chase, NOW, TZ)).toEqual([]);
    expect(taskSettingsErrors(S)).toEqual([]);
    expect(taskSettingsErrors({ ...S, followUpQuoteDays: 0, replyAfterHours: 1.5 })).toHaveLength(
      2,
    );
  });
});

describe('taskBucket (business-local day)', () => {
  const at = (iso: string | null, status = 'open', snoozedUntil: string | null = null) =>
    taskBucket({ status, dueAt: iso, snoozedUntil }, NOW, TZ);
  it('splits by local midnight', () => {
    expect(at('2026-10-23T10:59:59.999Z')).toBe('overdue'); // 23:59:59 NZDT 23 Oct
    expect(at('2026-10-23T11:00:00.000Z')).toBe('today'); // 00:00 NZDT 24 Oct
    expect(at('2026-10-24T10:59:59.999Z')).toBe('today');
    expect(at('2026-10-24T11:00:00.000Z')).toBe('upcoming');
    expect(at(null)).toBe('today');
    expect(at(null, 'done')).toBe('closed');
  });
  it('treats a lapsed snooze as open from the snooze time', () => {
    expect(at(null, 'snoozed', '2026-10-25T00:00:00.000Z')).toBe('snoozed');
    expect(at(null, 'snoozed', '2026-10-23T20:00:00.000Z')).toBe('today');
  });
});
