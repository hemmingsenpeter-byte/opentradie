import { useCallback, useEffect, useState } from 'react';
import {
  createAutomation,
  deleteAutomation,
  fetchAutomationCatalogue,
  fetchAutomationEvents,
  fetchAutomationRuns,
  fetchAutomations,
  setAutomationEnabled,
  testAutomation,
  updateAutomation,
  validateAutomation,
  type Automation,
  type AutomationAction,
  type AutomationCatalogue,
  type AutomationDefinition,
  type AutomationRun,
  type BuiltInAutomation,
  type Comparison,
  type Validation,
} from '../automations-api';
import {
  Button,
  ErrorNotice,
  Loading,
  Notice,
  Pill,
  SelectField,
  TextArea,
  TextField,
} from '../components/ui';
import { useWorkspace } from '../workspace';

/**
 * Settings › Automations (Feature 17, ADR 0033). The owner designs; the server validates,
 * summarises and runs deterministically. Every action is a proposal under the normal approval
 * rules; customer messages are always drafts for approval.
 */

const OPS: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  gt: 'more than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
};
const OPS_BY_TYPE: Record<string, string[]> = {
  text: ['contains', 'not_contains', 'eq', 'neq'],
  number: ['gte', 'gt', 'lte', 'lt', 'eq', 'neq'],
  enum: ['eq', 'neq'],
};
const ACTION_LABELS: Record<string, string> = {
  'communication.draft': 'Draft a customer message (always for approval)',
  'task.create': 'Add a task for me',
  'job.add_note': 'Add a job note',
};

/** The editor works on a flat AND list of comparisons; nested conditions stay as they are. */
function conditionRows(definition: AutomationDefinition): Comparison[] | null {
  const filter = definition.trigger.filter;
  if (!filter) return [];
  if ('field' in filter) return [filter];
  if ('all' in filter && filter.all.every((child) => 'field' in child))
    return filter.all as Comparison[];
  return null;
}

function withRows(definition: AutomationDefinition, rows: Comparison[]): AutomationDefinition {
  const { filter: _filter, ...trigger } = definition.trigger;
  return {
    ...definition,
    trigger:
      rows.length === 0
        ? trigger
        : { ...trigger, filter: rows.length === 1 ? rows[0]! : { all: rows } },
  };
}

function Editor({
  automation,
  catalogue,
  onSaved,
  onClose,
}: {
  automation: Automation;
  catalogue: AutomationCatalogue;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AutomationDefinition>(automation.definition);
  const [check, setCheck] = useState<Validation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<Array<{ id: string; occurredAt: string }>>([]);
  const [eventId, setEventId] = useState('');
  const [dry, setDry] = useState<Awaited<ReturnType<typeof testAutomation>> | null>(null);
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const rows = conditionRows(draft);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      validateAutomation(draft)
        .then((result) => live && setCheck(result))
        .catch(() => undefined);
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft]);
  useEffect(() => {
    fetchAutomationEvents(draft.trigger.event)
      .then((result) => setEvents(result.events))
      .catch(() => setEvents([]));
  }, [draft.trigger.event]);
  useEffect(() => {
    fetchAutomationRuns(automation.id)
      .then((result) => setRuns(result.runs))
      .catch(() => setRuns([]));
  }, [automation.id]);

  const setAction = (index: number, action: AutomationAction) =>
    setDraft({ ...draft, actions: draft.actions.map((item, i) => (i === index ? action : item)) });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await updateAutomation(automation.id, automation.version, draft);
      onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function dryRun() {
    setError(null);
    try {
      setDry(await testAutomation(automation.id, eventId, draft));
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <div className="grid gap-3" data-testid="automation-editor">
      <TextField
        label="Name"
        value={draft.name}
        maxLength={120}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
      <SelectField
        label="When"
        value={draft.trigger.event}
        onChange={(event) =>
          setDraft({ ...draft, trigger: { ...draft.trigger, event: event.target.value } })
        }
      >
        {catalogue.events
          .filter((item) => item.name !== 'schedule' || draft.trigger.event === 'schedule')
          .map((item) => (
            <option key={item.name} value={item.name}>
              {item.title}
            </option>
          ))}
      </SelectField>
      {rows === null ? (
        <p className="hint">
          This automation uses grouped conditions; edit them through the assistant or the API.
        </p>
      ) : (
        <fieldset className="grid gap-2">
          <legend>Only if</legend>
          {rows.map((row, index) => {
            const fact = catalogue.facts.find((item) => item.name === row.field);
            const update = (next: Comparison) =>
              setDraft(
                withRows(
                  draft,
                  rows.map((item, i) => (i === index ? next : item)),
                ),
              );
            return (
              <div key={index} className="grid gap-2 sm:grid-cols-3" data-testid="condition-row">
                <SelectField
                  label={`Condition ${index + 1} fact`}
                  value={row.field}
                  onChange={(event) => {
                    const next = catalogue.facts.find((item) => item.name === event.target.value)!;
                    update({
                      field: next.name,
                      op: OPS_BY_TYPE[next.type]![0]!,
                      value: next.type === 'number' ? 0 : (next.values?.[0] ?? ''),
                    });
                  }}
                >
                  {catalogue.facts.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.label}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label={`Condition ${index + 1} comparison`}
                  value={row.op}
                  onChange={(event) => update({ ...row, op: event.target.value })}
                >
                  {(OPS_BY_TYPE[fact?.type ?? 'text'] ?? []).map((op) => (
                    <option key={op} value={op}>
                      {OPS[op]}
                    </option>
                  ))}
                </SelectField>
                {fact?.type === 'enum' ? (
                  <SelectField
                    label={`Condition ${index + 1} value`}
                    value={String(row.value ?? '')}
                    onChange={(event) => update({ ...row, value: event.target.value })}
                  >
                    {fact.values!.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </SelectField>
                ) : (
                  <TextField
                    label={`Condition ${index + 1} value${fact?.type === 'number' ? ' (whole number)' : ''}`}
                    inputMode={fact?.type === 'number' ? 'numeric' : 'text'}
                    value={String(row.value ?? '')}
                    onChange={(event) =>
                      update({
                        ...row,
                        value:
                          fact?.type === 'number'
                            ? Number(event.target.value) || 0
                            : event.target.value,
                      })
                    }
                  />
                )}
                <Button
                  variant="quiet"
                  onClick={() =>
                    setDraft(
                      withRows(
                        draft,
                        rows.filter((_, i) => i !== index),
                      ),
                    )
                  }
                >
                  Remove condition {index + 1}
                </Button>
              </div>
            );
          })}
          <Button
            variant="quiet"
            icon="plus"
            onClick={() =>
              setDraft(
                withRows(draft, [...rows, { field: 'job.title', op: 'contains', value: '' }]),
              )
            }
          >
            Add condition
          </Button>
        </fieldset>
      )}
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend>Wait</legend>
        <TextField
          label="Days later"
          inputMode="numeric"
          value={String(draft.delay?.days ?? 0)}
          onChange={(event) =>
            setDraft({
              ...draft,
              delay: { ...draft.delay, days: Math.max(0, Number(event.target.value) || 0) },
            })
          }
        />
        <TextField
          label="At (business time, optional)"
          placeholder="09:00"
          value={draft.delay?.at ?? ''}
          onChange={(event) => {
            const { at: _at, ...rest } = draft.delay ?? {};
            setDraft({
              ...draft,
              delay: event.target.value ? { ...rest, at: event.target.value } : rest,
            });
          }}
        />
      </fieldset>
      {draft.actions.map((action, index) => (
        <fieldset key={index} className="grid gap-2" data-testid="action-row">
          <legend>
            Then {index + 1}: {ACTION_LABELS[action.tool] ?? action.tool}
          </legend>
          {typeof action.subject === 'string' && (
            <TextField
              label={`Action ${index + 1} subject`}
              value={action.subject}
              onChange={(event) => setAction(index, { ...action, subject: event.target.value })}
            />
          )}
          {(['text', 'title'] as const).map((key) =>
            typeof action[key] === 'string' ? (
              <div key={key} className="grid gap-1">
                <TextArea
                  label={`Action ${index + 1} ${key === 'text' ? 'message' : 'title'}`}
                  value={action[key] as string}
                  rows={key === 'text' ? 4 : 2}
                  onChange={(event) => setAction(index, { ...action, [key]: event.target.value })}
                />
                <div
                  className="flex flex-wrap gap-1"
                  aria-label={`Insert a placeholder into action ${index + 1}`}
                >
                  {catalogue.placeholders.map((placeholder) => (
                    <Button
                      key={placeholder.name}
                      variant="quiet"
                      onClick={() =>
                        setAction(index, {
                          ...action,
                          [key]: `${action[key] as string}{{${placeholder.name}}}`,
                        })
                      }
                    >
                      {placeholder.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null,
          )}
          {action.tool === 'task.create' && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={action.approval === 'auto'}
                onChange={(event) =>
                  setAction(index, { ...action, approval: event.target.checked ? 'auto' : 'owner' })
                }
              />
              <span>Add this task without asking me (owner to-dos only)</span>
            </label>
          )}
        </fieldset>
      ))}
      <div aria-live="polite" data-testid="automation-summary">
        {check?.ok ? (
          <Notice tone="info" title="What this does">
            {check.summary}
          </Notice>
        ) : check ? (
          <Notice tone="warning" title="Needs fixing">
            <ul>
              {check.errors.map((item, index) => (
                <li key={index}>{item.message}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" busy={busy} disabled={!check?.ok} onClick={() => void save()}>
          Save automation
        </Button>
        <Button onClick={onClose}>Close</Button>
      </div>
      <fieldset className="grid gap-2">
        <legend>Test (dry run, changes nothing)</legend>
        {events.length ? (
          <>
            <SelectField
              label="Recent event"
              value={eventId}
              onChange={(event) => setEventId(event.target.value)}
            >
              <option value="">Choose…</option>
              {events.map((item) => (
                <option key={item.id} value={item.id}>
                  {new Date(item.occurredAt).toLocaleString('en-NZ')}
                </option>
              ))}
            </SelectField>
            <Button disabled={!eventId || !check?.ok} onClick={() => void dryRun()}>
              Run test
            </Button>
          </>
        ) : (
          <p className="hint">No recent events of this kind to test against yet.</p>
        )}
        {dry && (
          <div data-testid="dry-run" className="grid gap-1">
            <p>{dry.matches ? 'It would run.' : `It would not run: ${dry.reason ?? ''}`}</p>
            {dry.matches &&
              dry.actions.map((item, index) => (
                <p key={index} className="hint">
                  {item.tool}
                  {item.skipped
                    ? ` skipped (${item.skipped})`
                    : ` → ${item.approval === 'auto' ? 'runs automatically' : 'proposal for your approval'}`}
                  {typeof item.input?.text === 'string' ? `: “${item.input.text}”` : ''}
                </p>
              ))}
          </div>
        )}
      </fieldset>
      <section aria-label="Run history" className="grid gap-1">
        <h3 className="section-title">Run history</h3>
        {runs === null ? (
          <Loading />
        ) : runs.length === 0 ? (
          <p className="hint">No runs yet.</p>
        ) : (
          <ul className="grid gap-1" data-testid="automation-runs">
            {runs.map((run) => (
              <li key={run.id}>
                {new Date(run.createdAt).toLocaleString('en-NZ')}: {run.status}
                {run.outcomeCode ? ` (${run.outcomeCode.replace(/_/g, ' ')})` : ''}
                {run.proposalIds.length ? `, ${run.proposalIds.length} proposal(s)` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function AutomationsSettings() {
  const { state } = useWorkspace();
  const isOwner = state?.user.role === 'owner';
  const [list, setList] = useState<{
    automations: Automation[];
    builtIn: BuiltInAutomation[];
  } | null>(null);
  const [catalogue, setCatalogue] = useState<AutomationCatalogue | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [automations, templates] = await Promise.all([
        fetchAutomations(),
        fetchAutomationCatalogue(),
      ]);
      setList(automations);
      setCatalogue(templates);
    } catch (caught) {
      setError(caught);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, run: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await run();
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  }

  if (!list || !catalogue)
    return error ? <ErrorNotice error={error} retry={() => void load()} /> : <Loading />;
  const current = list.automations.find((item) => item.id === editing);
  return (
    <div className="grid gap-3" data-testid="automations">
      <p className="hint">
        Automations run on fixed rules you can read. Each step is a proposal under your approval
        settings; customer messages are always drafts for you to approve. Prices, GST and approvals
        cannot be changed by an automation.
      </p>
      {error ? <ErrorNotice error={error} /> : null}
      {current ? (
        <Editor
          automation={current}
          catalogue={catalogue}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : (
        <>
          <ul className="grid gap-2" aria-label="Your automations">
            {list.automations.length === 0 && (
              <li className="hint">No automations yet. Start from a template below.</li>
            )}
            {list.automations.map((automation) => (
              <li key={automation.id} className="grid gap-1" data-testid="automation-item">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{automation.name}</strong>
                  <Pill tone={automation.enabled ? 'approved' : 'neutral'}>
                    {automation.enabled ? 'On' : 'Off'}
                  </Pill>
                  {automation.source === 'agent' && <Pill tone="info">Drafted by assistant</Pill>}
                </div>
                <p className="hint">{automation.summary}</p>
                <p className="hint">
                  Last run:{' '}
                  {automation.lastRun
                    ? `${automation.lastRun.status}, ${new Date(automation.lastRun.at).toLocaleString('en-NZ')}`
                    : 'never'}
                </p>
                {isOwner && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant={automation.enabled ? 'secondary' : 'go'}
                      busy={busy === automation.id}
                      onClick={() =>
                        void act(automation.id, () =>
                          setAutomationEnabled(
                            automation.id,
                            automation.version,
                            !automation.enabled,
                          ),
                        )
                      }
                    >
                      {automation.enabled
                        ? `Turn off ${automation.name}`
                        : `Turn on ${automation.name}`}
                    </Button>
                    <Button onClick={() => setEditing(automation.id)}>
                      Edit {automation.name}
                    </Button>
                    <Button
                      variant="quiet"
                      onClick={() =>
                        void act(automation.id, () =>
                          deleteAutomation(automation.id, automation.version),
                        )
                      }
                    >
                      Delete {automation.name}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <h3 className="section-title">Templates</h3>
          <ul className="grid gap-2" aria-label="Automation templates">
            {catalogue.templates.map((template) => (
              <li
                key={template.key}
                className="grid gap-1"
                data-testid={`template-${template.key}`}
              >
                <strong>{template.title}</strong>
                <p className="hint">{template.summary ?? template.description}</p>
                {isOwner && (
                  <Button
                    icon="plus"
                    busy={busy === template.key}
                    onClick={() =>
                      void act(template.key, () =>
                        createAutomation({ templateKey: template.key }, true),
                      )
                    }
                  >
                    Use {template.title}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <h3 className="section-title">Built in</h3>
          <ul className="grid gap-2" aria-label="Built-in automations">
            {list.builtIn.map((item) => (
              <li key={item.key} className="grid gap-1">
                <strong>{item.name}</strong> <Pill tone="neutral">Built in</Pill>
                <p className="hint">
                  {item.summary} Configure in{' '}
                  <a href={item.configure.href}>{item.configure.label}</a>.
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
