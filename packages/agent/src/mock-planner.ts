import type { JobActionRequest, PlannedToolCall } from './types.js';

/**
 * Deterministic, synthetic planner for the mock runtime: turns a short job update ("2.5 hours
 * labour, 3 cable clips at $4.50 each, mark the job completed") into business tool calls.
 * It is pattern matching, not a model, and its output is untrusted like any agent's: the API
 * validates every call against the tool registry and turns it into a proposal for the owner.
 *
 * It never emits prices. A supplier cost read from the text becomes `reportedUnitCostCents`,
 * which the backend treats as a reported cost needing owner confirmation and markup.
 */
export function mockPlanJobActions(request: JobActionRequest): PlannedToolCall[] {
  const text = request.text.trim();
  const calls: PlannedToolCall[] = [];
  const clarifications: string[] = [];

  const hours = /\b(\d{1,2}(?:\.\d{1,3})?)\s*(?:h|hrs?|hours?)\b/i.exec(text);
  const halfHour = /\bhalf an hour\b/i.test(text);
  const quantityMilli = hours ? decimalToMilli(hours[1]!) : halfHour ? 500 : null;
  if (quantityMilli !== null && quantityMilli > 0 && quantityMilli <= 24_000) {
    const hourly = request.context.rates.filter((rate) => rate.unit === 'hour');
    const rate = hourly.find((candidate) => /labou?r/i.test(candidate.code)) ?? hourly[0];
    if (rate)
      calls.push({
        tool: 'job.record_time',
        arguments: { rateCode: rate.code, quantityMilli, description: 'Labour' },
      });
    else clarifications.push('No approved hourly rate exists. Which rate should this time use?');
  }

  const material =
    /\b(\d{1,4})\s*(?:x\s+)?([a-z][a-z0-9 -]{1,40}?)\s+(?:at|@)\s*\$(\d{1,6})(?:\.(\d{1,2}))?/gi;
  for (const match of text.matchAll(material)) {
    const quantity = Number(match[1]);
    if (!Number.isSafeInteger(quantity) || quantity < 1) continue;
    const cents = Number(match[3]) * 100 + Number((match[4] ?? '0').padEnd(2, '0'));
    calls.push({
      tool: 'job.add_material',
      arguments: {
        description: match[2]!.trim().slice(0, 200),
        quantityMilli: quantity * 1000,
        unit: 'each',
        reportedUnitCostCents: cents,
      },
    });
  }

  const status = statusFrom(text);
  if (status && status !== request.context.jobStatus)
    calls.push({ tool: 'job.update_status', arguments: { status } });

  // The update itself is kept as a note, verbatim and inert: it is text, never an instruction.
  calls.push({
    tool: 'job.add_note',
    arguments: {
      text: text.slice(0, 4000),
      ...(clarifications.length ? { clarifications } : {}),
    },
  });
  return calls;
}

function decimalToMilli(value: string): number {
  const [whole = '0', fraction = ''] = value.split('.');
  return Number(whole) * 1000 + Number(fraction.padEnd(3, '0').slice(0, 3));
}

function statusFrom(text: string): string | null {
  const explicit =
    /\b(?:mark|set|move)\b[^.!?\n]{0,40}?\b(?:as\s+|to\s+)?(completed?|done|finished|in progress|started|cancell?ed|scheduled)\b/i.exec(
      text,
    )?.[1] ?? /\bjob(?:'s| is)\s+(done|finished|completed?)\b/i.exec(text)?.[1];
  if (!explicit) return null;
  const word = explicit.toLowerCase();
  if (['complete', 'completed', 'done', 'finished'].includes(word)) return 'completed';
  if (word === 'in progress' || word === 'started') return 'in_progress';
  if (word.startsWith('cancel')) return 'cancelled';
  return 'scheduled';
}

/**
 * Deterministic, synthetic automation author for the mock runtime (ADR 0033). It recognises a
 * few sentence shapes ("When I finish a job, ask the customer for a Google review the next day,
 * except warranty call-backs") and returns one `automation.propose` call, or null. Pattern
 * matching, not a model; the backend validates the definition and the owner approves it.
 */
export function mockPlanAutomation(text: string): PlannedToolCall | null {
  const sentence = text.trim();
  const finishJob = /\bwhen (?:i|we) (?:finish|complete)\b[^,.]*\bjob\b/i.test(sentence);
  const review = /\breview\b/i.test(sentence);
  if (!finishJob || !review) return null;
  const except =
    /\bexcept\s+(?:for\s+)?([a-z][a-z -]{1,40}?)(?:\s+call[- ]?backs?|\s+jobs?)?\s*[.!]?$/i.exec(
      sentence,
    );
  const exclude = except?.[1]?.trim().split(/\s+/)[0]?.toLowerCase();
  const nextDay = /\b(?:next|following) day\b|\btomorrow\b|\b1 day\b/i.test(sentence);
  const google = /\bgoogle\b/i.test(sentence);
  return {
    tool: 'automation.propose',
    arguments: {
      definition: {
        name: google ? 'Google review request' : 'Review request',
        trigger: {
          event: 'job.completed',
          ...(exclude
            ? { filter: { field: 'job.title', op: 'not_contains', value: exclude } }
            : {}),
        },
        delay: nextDay ? { days: 1, at: '09:00' } : { at: '09:00' },
        actions: [
          {
            tool: 'communication.draft',
            channel: 'email',
            subject: 'Thanks from {{business.name}}',
            text: `Hi {{customer.firstName}}, thanks for choosing {{business.name}} for "{{job.title}}". If you were happy with the work, would you leave us a ${google ? 'Google ' : ''}review? It helps a small business a lot.`,
          },
        ],
      },
    },
  };
}
