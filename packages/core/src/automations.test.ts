import { describe, expect, it } from 'vitest';
import { parseToolCall } from './agent-tools.js';
import { automationEventsForJobEvent } from './automation-events.js';
import {
  actionApproval,
  AUTOMATION_TEMPLATES,
  automationDueAt,
  evaluateCondition,
  renderTemplate,
  scheduleOccurrence,
  templateErrors,
  validateAutomation,
  type AutomationDefinitionInput,
} from './automations.js';

const TZ = 'Pacific/Auckland';
const base: AutomationDefinitionInput = {
  name: 'Review request',
  trigger: {
    event: 'job.completed',
    filter: { field: 'job.title', op: 'not_contains', value: 'warranty' },
  },
  delay: { days: 1, at: '09:00' },
  actions: [{ tool: 'communication.draft', channel: 'email', text: 'Hi {{customer.firstName}}' }],
};
const errorsOf = (input: unknown) => {
  const result = validateAutomation(input);
  return result.ok ? [] : result.errors.map((error) => error.message).join(' | ');
};

describe('automation validation', () => {
  it('accepts every template and summarises it in plain English', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      const result = validateAutomation(template.definition);
      expect(result.ok, template.key).toBe(true);
    }
    const result = validateAutomation(base);
    expect(result.ok && result.summary).toBe(
      'When a job is completed and the job title does not contain "warranty", 1 day later at 09:00: draft an email message to the customer for your approval (never sent automatically). At most once per record.',
    );
    const quote = validateAutomation(AUTOMATION_TEMPLATES[1]!.definition);
    expect(quote.ok && quote.summary).toContain('the quote total is at least $2,000.00');
  });

  it('rejects unknown fields, tools, facts and placeholders', () => {
    expect(errorsOf({ ...base, script: 'x' })).not.toEqual([]);
    expect(errorsOf({ ...base, actions: [{ tool: 'quote.prepare', jobId: 'x' }] })).not.toEqual([]);
    expect(errorsOf({ ...base, actions: [{ tool: 'shell.exec', command: 'rm' }] })).not.toEqual([]);
    expect(
      errorsOf({
        ...base,
        trigger: { event: 'job.completed', filter: { field: 'job.secret', op: 'eq', value: 'a' } },
      }),
    ).not.toEqual([]);
    expect(
      errorsOf({ ...base, actions: [{ tool: 'job.add_note', text: 'Hi {{customer.email}}' }] }),
    ).toContain('Unknown placeholder {{customer.email}}.');
    expect(templateErrors('{{ job.title }} ok')).toEqual([]);
    expect(templateErrors('{{job.title')).not.toEqual([]);
    expect(errorsOf({ ...base, trigger: { event: 'job.finished' } })).not.toEqual([]);
  });

  it('rejects money fields anywhere and wrong operator types', () => {
    expect(
      errorsOf({ ...base, actions: [{ tool: 'task.create', title: 'x', priceCents: 100 }] }),
    ).toContain('Automations cannot set prices');
    expect(
      errorsOf({
        ...base,
        trigger: {
          event: 'quote.sent',
          filter: { field: 'quote.totalCents', op: 'contains', value: 'x' },
        },
      }),
    ).not.toEqual([]);
    expect(
      errorsOf({
        ...base,
        trigger: {
          event: 'quote.sent',
          filter: { field: 'job.status', op: 'eq', value: 'nonsense' },
        },
      }),
    ).toContain('Unknown value');
  });

  it('refuses auto-approval for customer-facing tools and self-triggering loops', () => {
    expect(
      errorsOf({
        ...base,
        actions: [{ tool: 'communication.draft', channel: 'email', text: 'x', approval: 'auto' }],
      }),
    ).toContain('always needs owner approval');
    expect(
      errorsOf({
        ...base,
        trigger: { event: 'task.created' },
        actions: [{ tool: 'task.create', title: 'again' }],
      }),
    ).toContain('loop');
    expect(
      errorsOf({ ...base, actions: [{ tool: 'job.update_status', status: 'completed' }] }),
    ).toContain('loop');
    expect(
      errorsOf({
        ...base,
        trigger: { event: 'schedule' },
        actions: [{ tool: 'task.create', title: 'Weekly review' }],
      }),
    ).toContain('needs a schedule');
    expect(
      validateAutomation({
        ...base,
        trigger: { event: 'schedule', schedule: { frequency: 'weekly', weekday: 1, at: '07:30' } },
        delay: undefined,
        actions: [{ tool: 'task.create', title: 'Weekly review', approval: 'auto' }],
      }).ok,
    ).toBe(true);
  });

  it('resolves per-action approval within the registry', () => {
    expect(actionApproval({ tool: 'task.create', title: 'x', approval: 'auto' }, 'owner')).toBe(
      'auto',
    );
    expect(actionApproval({ tool: 'task.create', title: 'x' }, 'auto')).toBe('auto');
    expect(actionApproval({ tool: 'task.create', title: 'x', approval: 'owner' }, 'auto')).toBe(
      'owner',
    );
    expect(
      actionApproval(
        { tool: 'communication.draft', channel: 'sms', text: 'x', approval: 'auto' },
        'auto',
      ),
    ).toBe('owner');
  });

  it('accepts a valid automation.propose call and refuses an invalid one', () => {
    expect(parseToolCall('automation.propose', { definition: base }).ok).toBe(true);
    const bad = parseToolCall('automation.propose', {
      definition: { ...base, actions: [{ tool: 'job.add_note', text: '{{secret}}' }] },
    });
    expect(bad.ok).toBe(false);
  });
});

describe('condition evaluator', () => {
  it('compares text case-insensitively, numbers numerically, and nests AND/OR/NOT', () => {
    const facts = { 'job.title': 'Warranty call-back: RCD', 'quote.totalCents': 250_000 };
    expect(
      evaluateCondition({ field: 'job.title', op: 'contains', value: 'warranty' }, facts),
    ).toBe(true);
    expect(
      evaluateCondition({ field: 'job.title', op: 'not_contains', value: 'warranty' }, facts),
    ).toBe(false);
    expect(evaluateCondition({ field: 'quote.totalCents', op: 'gte', value: 200_000 }, facts)).toBe(
      true,
    );
    expect(
      evaluateCondition(
        {
          any: [
            { field: 'quote.totalCents', op: 'lt', value: 1 },
            { not: { field: 'job.status', op: 'exists' } },
          ],
        },
        facts,
      ),
    ).toBe(true);
    expect(
      evaluateCondition({ all: [{ field: 'job.status', op: 'eq', value: 'completed' }] }, facts),
    ).toBe(false);
    expect(evaluateCondition(undefined, {})).toBe(true);
  });
});

describe('templates and timing', () => {
  it('renders whitelisted placeholders and neutralises hostile values', () => {
    expect(
      renderTemplate('Hi {{customer.firstName}}, re {{job.title}}{{unknown.x}}', {
        'customer.firstName': 'Ann\r\nBcc: all@example.test {{business.name}} <b>',
        'job.title': 'Heat pump',
      }),
    ).toBe('Hi Ann Bcc: all@example.test business.name b, re Heat pump');
    expect(renderTemplate('Hi {{customer.firstName}}', {})).toBe('Hi there');
  });

  it('computes delays in business time and schedule occurrences', () => {
    // 2026-11-02 15:00 NZDT (UTC+13) -> next day 09:00 local = 2026-11-02T20:00Z.
    const from = Date.parse('2026-11-02T02:00:00Z');
    expect(automationDueAt(from, { days: 1, at: '09:00' }, TZ).toISOString()).toBe(
      '2026-11-02T20:00:00.000Z',
    );
    expect(automationDueAt(from, { hours: 2 }, TZ).toISOString()).toBe('2026-11-02T04:00:00.000Z');
    expect(automationDueAt(from, undefined, TZ).getTime()).toBe(from);
    // 06:00 local on a Monday (2026-11-02 is a Monday).
    const monday6am = Date.parse('2026-11-01T17:00:00Z');
    expect(
      scheduleOccurrence({ frequency: 'weekly', weekday: 1, at: '07:30' }, monday6am, TZ),
    ).toBeNull();
    expect(scheduleOccurrence({ frequency: 'daily', at: '05:00' }, monday6am, TZ)).toBe(
      '2026-11-02',
    );
  });

  it('maps job timeline entries to automation events', () => {
    expect(
      automationEventsForJobEvent({
        type: 'status_changed',
        fromStatus: 'in_progress',
        toStatus: 'completed',
      }).map((event) => event.event),
    ).toEqual(['job.status_changed', 'job.completed']);
    const quoteId = '11111111-1111-4111-8111-111111111111';
    expect(automationEventsForJobEvent({ type: 'quote_sent', metadata: { quoteId } })).toEqual([
      { event: 'quote.sent', refs: { quoteId }, data: {} },
    ]);
    expect(
      automationEventsForJobEvent({
        type: 'invoice_posted',
        metadata: { invoiceId: quoteId, amountPaidCents: 5 },
      }),
    ).toEqual([]);
    expect(automationEventsForJobEvent({ type: 'note_added' })).toEqual([]);
  });
});
