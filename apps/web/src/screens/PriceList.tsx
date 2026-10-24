import { useCallback, useEffect, useState } from 'react';
import {
  RATES_EXPORT_URL,
  createRate,
  getRateHistory,
  importRates,
  listManagedRates,
  newIdempotencyKey,
  reactivateRate,
  retireRate,
  updateRate,
} from '../api';
import { Icon } from '../components/Icons';
import {
  Button,
  Dialog,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Pill,
  Section,
  SelectField,
  TextField,
  ViewOnlyNote,
} from '../components/ui';
import { centsToText, formatDate } from '../format';
import { href } from '../router';
import type { ManagedRate, RateImportDiff, RateUnit, RateVersion } from '../types';
import { useWorkspace } from '../workspace';

const UNITS: { value: RateUnit; label: string }[] = [
  { value: 'each', label: 'Each' },
  { value: 'hour', label: 'Per hour' },
  { value: 'visit', label: 'Per visit' },
];
const unitLabel = (unit: string) => UNITS.find((u) => u.value === unit)?.label ?? unit;
const CHANGE_LABEL: Record<RateVersion['change'], string> = {
  created: 'Added',
  updated: 'Changed',
  retired: 'Retired',
  reactivated: 'Reactivated',
  imported: 'Imported',
};

type Editing = { mode: 'add' } | { mode: 'edit'; rate: ManagedRate };

/**
 * Settings › Price list: the owner's approved rate card. Prices are typed in dollars and sent
 * as text; the server parses them to integer cents (ADR 0030). Viewers see the list read-only.
 */
export function PriceListScreen() {
  const { isOwner, reload, money, state } = useWorkspace();
  const [rates, setRates] = useState<ManagedRate[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [history, setHistory] = useState<ManagedRate | null>(null);
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRates((await listManagedRates()).rates);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function changed(message: string) {
    setNotice(message);
    await Promise.all([load(), reload().catch(() => undefined)]);
  }

  async function toggle(rate: ManagedRate) {
    setError(null);
    setBusyCode(rate.code);
    try {
      if (rate.active) await retireRate(rate.code);
      else await reactivateRate(rate.code);
      await changed(rate.active ? `“${rate.label}” retired.` : `“${rate.label}” reactivated.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusyCode(null);
    }
  }

  const gstNote =
    state.business.gstRegistered === false
      ? 'Not GST registered'
      : state.business.pricesEntered === 'inclusive'
        ? 'Prices include GST'
        : 'Prices exclude GST';

  return (
    <div className="stack">
      <PageHeader
        title="Price list"
        eyebrow="Your approved rates"
        back={{ href: href('settings'), label: 'Settings' }}
        actions={
          isOwner ? (
            <Button variant="primary" icon="plus" onClick={() => setEditing({ mode: 'add' })}>
              Add rate
            </Button>
          ) : undefined
        }
      />
      <Notice tone="info">
        Quotes and the assistant price work only from active rates on this list. {gstNote}. Changing
        a price keeps its history; quotes and invoices already issued keep the price they were
        issued with.
      </Notice>
      {notice && (
        <div role="status">
          <Notice tone="success">{notice}</Notice>
        </div>
      )}
      {error !== null && <ErrorNotice title="That did not work" error={error} />}

      <Section
        className="min-w-0"
        title="Rates"
        count={rates?.filter((rate) => rate.active).length}
      >
        {rates === null ? (
          <Loading label="Loading rates…" />
        ) : rates.length === 0 ? (
          <p className="muted">
            No rates yet. Add your first rate or import your price sheet. Nothing is priced until
            you approve a rate.
          </p>
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Rates table">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">Unit</th>
                  <th scope="col" className="num">
                    Price
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rates.map((rate) => (
                  <tr key={rate.code} className={rate.active ? '' : 'is-retired'}>
                    <th scope="row">
                      <span className="row-title">{rate.label}</span>
                      <span className="row-sub">{rate.code}</span>
                    </th>
                    <td>{unitLabel(rate.unit)}</td>
                    <td className="num">{money(rate.unitPriceCents)}</td>
                    <td>
                      <Pill tone={rate.active ? 'approved' : 'neutral'}>
                        {rate.active ? 'Active' : 'Retired'}
                      </Pill>
                    </td>
                    <td>
                      <div className="table-actions">
                        <Button
                          aria-label={`History of ${rate.label}`}
                          onClick={() => setHistory(rate)}
                        >
                          History
                        </Button>
                        {isOwner && (
                          <>
                            <Button
                              icon="edit"
                              aria-label={`Edit ${rate.label}`}
                              onClick={() => setEditing({ mode: 'edit', rate })}
                            >
                              Edit
                            </Button>
                            <Button
                              busy={busyCode === rate.code}
                              disabled={busyCode !== null}
                              aria-label={`${rate.active ? 'Retire' : 'Reactivate'} ${rate.label}`}
                              onClick={() => void toggle(rate)}
                            >
                              {rate.active ? 'Retire' : 'Reactivate'}
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!isOwner && (
          <ViewOnlyNote>Only the business owner can change the price list.</ViewOnlyNote>
        )}
      </Section>

      {isOwner && (
        <Section title="Import or export">
          <ImportRates onApplied={(message) => void changed(message)} />
        </Section>
      )}

      {editing && (
        <RateForm
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            void changed(message);
          }}
        />
      )}
      {history && <RateHistory rate={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function RateForm({
  editing,
  onClose,
  onSaved,
}: {
  editing: Editing;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const existing = editing.mode === 'edit' ? editing.rate : null;
  const [code, setCode] = useState(existing?.code ?? '');
  const [label, setLabel] = useState(existing?.label ?? '');
  const [unit, setUnit] = useState<RateUnit>(existing?.unit ?? 'each');
  const [price, setPrice] = useState(existing ? centsToText(existing.unitPriceCents) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // One key per form instance: a double-tap or retry cannot add the rate twice.
  const [key] = useState(newIdempotencyKey);

  async function save() {
    setError(null);
    if (!label.trim()) return setError(new Error('Describe the service.'));
    if (!price.trim()) return setError(new Error('Enter a price in dollars, e.g. 85 or 1,234.50.'));
    setBusy(true);
    try {
      if (existing) {
        await updateRate(existing.code, { label: label.trim(), unit, price: price.trim() });
        onSaved(`“${label.trim()}” saved.`);
      } else {
        await createRate(
          { code: code.trim(), label: label.trim(), unit, price: price.trim() },
          key,
        );
        onSaved(`“${label.trim()}” added.`);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Dialog title={existing ? 'Edit rate' : 'Add rate'} onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {existing ? (
          <p className="muted">
            Code <strong>{existing.code}</strong>
          </p>
        ) : (
          <TextField
            label="Code"
            hint="Lower-case letters, digits and _, e.g. heat_pump_service. Cannot be changed later."
            value={code}
            autoCapitalize="none"
            autoComplete="off"
            required
            onChange={(event) => setCode(event.target.value)}
          />
        )}
        <TextField
          label="Description"
          value={label}
          required
          maxLength={200}
          onChange={(event) => setLabel(event.target.value)}
        />
        <SelectField
          label="Unit"
          value={unit}
          onChange={(event) => setUnit(event.target.value as RateUnit)}
        >
          {UNITS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Price (NZD)"
          hint="In dollars, e.g. 85 or 1,234.50. Checked and stored in cents by the server."
          inputMode="decimal"
          value={price}
          required
          onChange={(event) => setPrice(event.target.value)}
        />
        {existing && (
          <p className="hint">
            A new price applies to new quote lines. Quotes already drafted, sent or invoiced keep
            their price.
          </p>
        )}
        {error !== null && <ErrorNotice title="Rate not saved" error={error} />}
        <Button type="submit" variant="primary" icon="check" busy={busy} disabled={busy}>
          {existing ? 'Save rate' : 'Add rate'}
        </Button>
      </form>
    </Dialog>
  );
}

function RateHistory({ rate, onClose }: { rate: ManagedRate; onClose: () => void }) {
  const { money } = useWorkspace();
  const [versions, setVersions] = useState<RateVersion[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    getRateHistory(rate.code).then(
      (result) => setVersions(result.versions),
      (err: unknown) => setError(err),
    );
  }, [rate.code]);
  return (
    <Dialog title={`Price history: ${rate.label}`} onClose={onClose}>
      {error !== null && <ErrorNotice title="History not loaded" error={error} />}
      {versions === null && error === null ? (
        <Loading label="Loading history…" />
      ) : (
        <ol className="rows" aria-label="Versions, newest first">
          {(versions ?? []).map((version, index) => (
            <li key={index} className="row row-static">
              <span className="row-main">
                <span className="row-title">
                  {CHANGE_LABEL[version.change]} · {formatDate(version.effectiveFrom)}
                </span>
                <span className="row-sub">
                  {version.label} · {unitLabel(version.unit)}
                  {version.changedBy ? ` · by ${version.changedBy}` : ''}
                </span>
              </span>
              <span className="row-amount">{money(version.unitPriceCents)}</span>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}

function ImportRates({ onApplied }: { onApplied: (message: string) => void }) {
  const { money } = useWorkspace();
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [diff, setDiff] = useState<RateImportDiff | null>(null);
  const [problems, setProblems] = useState<{ line: number; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function preview(text: string) {
    setError(null);
    setProblems([]);
    setDiff(null);
    setBusy(true);
    try {
      setDiff(await importRates(text, 'preview'));
    } catch (err) {
      const details = (err as { details?: { errors?: { line: number; message: string }[] } })
        .details;
      if (details?.errors?.length) setProblems(details.errors);
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!csv) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importRates(csv, 'apply');
      setDiff(null);
      setCsv(null);
      setFileName('');
      onApplied(`Imported: ${result.create.length} added, ${result.update.length} changed.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const nothingToDo = diff !== null && diff.create.length === 0 && diff.update.length === 0;

  return (
    <div className="grid gap-3">
      <p className="muted">
        Export your price list as a spreadsheet (CSV), edit it in Excel, Numbers or Google Sheets,
        and import it back. You see every change before it is applied. Rates left out of the file
        are not retired; retire them here.
      </p>
      <div className="privacy-actions">
        <a className="btn btn-secondary" href={RATES_EXPORT_URL} download="rates.csv">
          <Icon name="file" />
          <span>Export CSV</span>
        </a>
      </div>
      <div className="field">
        <label htmlFor="rates-import-file">Import a CSV file</label>
        <input
          id="rates-import-file"
          type="file"
          accept=".csv,text/csv"
          aria-describedby="rates-import-hint"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setFileName(file.name);
            void file.text().then((text) => {
              setCsv(text);
              void preview(text);
            });
          }}
        />
        <p id="rates-import-hint" className="hint">
          Columns: code, description, unit, and the price column from the export.
        </p>
      </div>
      {busy && <Loading label="Checking the file…" />}
      {error !== null && <ErrorNotice title="Import not ready" error={error} />}
      {problems.length > 0 && (
        <ul className="rows" aria-label="Problems in the file">
          {problems.map((problem, index) => (
            <li key={index} className="row row-static">
              <span className="row-main">
                <span className="row-title">{problem.line ? `Line ${problem.line}` : 'File'}</span>
                <span className="row-sub">{problem.message}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {diff && (
        <div className="grid gap-3" aria-label={`Preview of ${fileName}`} role="region">
          <h3 className="section-title">Preview: {fileName}</h3>
          {nothingToDo && (
            <Notice tone="info">The file matches your price list. Nothing to change.</Notice>
          )}
          {diff.create.length > 0 && (
            <>
              <p className="eyebrow">New rates ({diff.create.length})</p>
              <ul className="rows">
                {diff.create.map((rate) => (
                  <li key={rate.code} className="row row-static">
                    <span className="row-main">
                      <span className="row-title">{rate.label}</span>
                      <span className="row-sub">
                        {rate.code} · {unitLabel(rate.unit ?? '')}
                      </span>
                    </span>
                    <span className="row-amount">{money(rate.unitPriceCents)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {diff.update.length > 0 && (
            <>
              <p className="eyebrow">Changed rates ({diff.update.length})</p>
              <ul className="rows">
                {diff.update.map((change) => (
                  <li key={change.code} className="row row-static">
                    <span className="row-main">
                      <span className="row-title">{change.after.label}</span>
                      <span className="row-sub">
                        {change.code}
                        {change.fields.includes('unitPriceCents')
                          ? ` · was ${money(change.before.unitPriceCents)}`
                          : ''}
                      </span>
                    </span>
                    <span className="row-amount">{money(change.after.unitPriceCents)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {diff.notInFile.length > 0 && (
            <p className="hint">Not in the file, left as they are: {diff.notInFile.join(', ')}.</p>
          )}
          {diff.retiredInFile.length > 0 && (
            <p className="hint">
              Retired rates in the file stay retired: {diff.retiredInFile.join(', ')}.
            </p>
          )}
          {!nothingToDo && (
            <Button
              variant="primary"
              icon="check"
              busy={busy}
              disabled={busy}
              onClick={() => void apply()}
            >
              Apply import
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
