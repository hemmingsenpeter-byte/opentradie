import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  approveInvoice,
  getAccountingStatus,
  getInvoice,
  invoicePdfUrl,
  listInvoices,
  newIdempotencyKey,
  recordMockPayment,
  retryInvoiceSync,
  syncAccountingNow,
  updateInvoiceLines,
  voidInvoice,
} from '../api';
import { formatDay, InvoiceRow, InvoiceStatusPill } from '../components/invoice';
import {
  Button,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Section,
  SelectField,
  TextField,
  ViewOnlyNote,
} from '../components/ui';
import { formatDate, formatRate, milliToText, parseQuantityMilli } from '../format';
import { href } from '../router';
import type { AccountingStatus, Invoice, InvoiceLineEdit } from '../types';
import { useWorkspace } from '../workspace';

export function InvoicesScreen({ segments }: { segments: string[] }) {
  const [id] = segments;
  return id ? <InvoiceDetail id={id} /> : <InvoiceList />;
}

function InvoiceList() {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setInvoices((await listInvoices()).invoices);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (error !== null)
    return <ErrorNotice title="Invoices didn’t load" error={error} retry={() => void load()} />;
  if (!invoices) return <Loading label="Loading invoices…" />;
  const groups: { title: string; match: (invoice: Invoice) => boolean }[] = [
    { title: 'Drafts', match: (invoice) => invoice.status === 'draft' },
    {
      title: 'Needs attention',
      match: (invoice) => invoice.status === 'sync_failed',
    },
    {
      title: 'Approved and posted',
      match: (invoice) => ['approved', 'posting', 'posted', 'part_paid'].includes(invoice.status),
    },
    { title: 'Paid', match: (invoice) => invoice.status === 'paid' },
    { title: 'Void', match: (invoice) => invoice.status === 'void' },
  ];
  return (
    <div className="stack">
      <PageHeader title="Invoices" eyebrow="Built from accepted quotes, time and materials" />
      {invoices.length === 0 ? (
        <Empty icon="file" title="No invoices yet">
          Open a completed job and choose “Create invoice”.
        </Empty>
      ) : (
        groups.map((group) => {
          const items = invoices.filter(group.match);
          if (!items.length) return null;
          return (
            <Section key={group.title} title={group.title} count={items.length}>
              <ul className="rows">
                {items.map((invoice) => (
                  <InvoiceRow key={invoice.id} invoice={invoice} />
                ))}
              </ul>
            </Section>
          );
        })
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  quote_line: 'from quote',
  time_entry: 'recorded time',
  material: 'material',
  manual: 'added by owner',
};

function InvoiceDetail({ id }: { id: string }) {
  const { isOwner, money } = useWorkspace();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [accounting, setAccounting] = useState<AccountingStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [loaded, status] = await Promise.all([
        getInvoice(id),
        getAccountingStatus().catch(() => null),
      ]);
      setInvoice(loaded);
      setAccounting(status);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  // While posting is queued, poll so the owner sees the outcome without reloading.
  useEffect(() => {
    if (invoice?.status !== 'approved' && invoice?.status !== 'posting') return;
    if (!accounting || accounting.provider === 'none') return;
    const timer = setInterval(() => void load(), 2_000);
    return () => clearInterval(timer);
  }, [invoice?.status, accounting, load]);

  async function act(name: string, run: () => Promise<unknown>, done?: string) {
    setBusy(name);
    setActionError(null);
    setMessage(null);
    try {
      await run();
      await load();
      if (done) setMessage(done);
    } catch (err) {
      setActionError(err);
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (error !== null)
    return (
      <div className="stack">
        <PageHeader title="Invoice" back={{ href: href('invoices'), label: 'Invoices' }} />
        <ErrorNotice title="Invoice didn’t load" error={error} retry={() => void load()} />
      </div>
    );
  if (!invoice) return <Loading label="Loading invoice…" />;

  const draft = invoice.status === 'draft';
  const blockers = [...invoice.readiness.missing, ...invoice.readiness.problems];
  const incomplete =
    actionError instanceof ApiError && actionError.code === 'INVOICE_INCOMPLETE'
      ? [
          ...((actionError.details.missing as string[] | undefined) ?? []),
          ...((actionError.details.problems as string[] | undefined) ?? []),
        ]
      : [];
  const acc = invoice.accounting;
  return (
    <div className="stack">
      <PageHeader
        title={invoice.invoiceNumber}
        eyebrow={invoice.gstRegistered ? 'Tax invoice' : 'Invoice'}
        back={{ href: href('invoices'), label: 'Invoices' }}
      >
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <InvoiceStatusPill status={invoice.status} />
          <a className="text-link" href={href('jobs', invoice.jobId)}>
            {invoice.jobTitle}
          </a>
          <span className="muted">{invoice.customerName}</span>
        </div>
      </PageHeader>

      {accounting?.mock && (
        <Notice tone="warning" title="Mock accounting adapter">
          Posting goes to OPENTRADIE’s fake accounting adapter, not to Xero. Nothing here is
          evidence of a real accounting integration.
        </Notice>
      )}
      {message && <Notice tone="success">{message}</Notice>}
      {actionError !== null && incomplete.length === 0 && (
        <ErrorNotice title="That didn’t work" error={actionError} />
      )}

      {draft && (blockers.length > 0 || incomplete.length > 0) && (
        <Notice tone="warning" title="Missing before it can be approved">
          <ul className="list-disc pl-5" data-testid="invoice-missing">
            {[...new Set([...blockers, ...incomplete])].map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="hint">
            New Zealand taxable supply information rules (GST Act). Fix these in Settings or on the
            customer, then approve.
          </p>
        </Notice>
      )}

      <Section title="Lines" count={invoice.lines.length}>
        <InvoiceLinesTable invoice={invoice} />
        <p className="hint">
          Issued {formatDay(invoice.issueDate)} · due {formatDay(invoice.dueDate)}. Calculated by
          OPENTRADIE; totals are never typed in.
        </p>
      </Section>

      {draft && isOwner && <DraftEditor invoice={invoice} onSaved={load} />}

      <Section title="Actions">
        <div className="flex flex-wrap gap-3">
          {draft &&
            (isOwner ? (
              <>
                <Button
                  variant="go"
                  icon="check"
                  busy={busy === 'approve'}
                  disabled={busy !== null}
                  onClick={() =>
                    void act(
                      'approve',
                      () => approveInvoice(invoice.id, invoice.version, newIdempotencyKey()),
                      accounting && accounting.provider !== 'none'
                        ? 'Invoice approved. Posting to accounting is queued.'
                        : 'Invoice approved.',
                    )
                  }
                >
                  Approve invoice
                </Button>
                <Button
                  variant="stop"
                  icon="close"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(
                      'void',
                      () => voidInvoice(invoice.id, invoice.version, newIdempotencyKey()),
                      'Draft voided. Its time and materials can be invoiced again.',
                    )
                  }
                >
                  Void draft
                </Button>
              </>
            ) : (
              <ViewOnlyNote>Only the business owner can approve or change invoices.</ViewOnlyNote>
            ))}
          {invoice.pdfAvailable && (
            <a
              className="btn btn-secondary"
              href={invoicePdfUrl(invoice.id)}
              target="_blank"
              rel="noreferrer"
            >
              <span>Download PDF</span>
            </a>
          )}
          {invoice.status === 'sync_failed' && isOwner && (
            <Button
              variant="primary"
              icon="refresh"
              busy={busy === 'retry'}
              disabled={busy !== null}
              onClick={() =>
                void act(
                  'retry',
                  () => retryInvoiceSync(invoice.id, newIdempotencyKey()),
                  'Posting queued again.',
                )
              }
            >
              Retry sync
            </Button>
          )}
          {['posted', 'part_paid'].includes(invoice.status) && isOwner && (
            <Button
              icon="refresh"
              busy={busy === 'sync'}
              disabled={busy !== null}
              onClick={() =>
                void act('sync', () => syncAccountingNow(), 'Payment status refreshed.')
              }
            >
              Check payments now
            </Button>
          )}
          {accounting?.mock && ['posted', 'part_paid'].includes(invoice.status) && isOwner && (
            <Button
              icon="check"
              disabled={busy !== null}
              onClick={() =>
                void act(
                  'mock-pay',
                  () => recordMockPayment(invoice.id),
                  'Mock payment recorded in the fake ledger. Use “Check payments now” to read it back.',
                )
              }
            >
              Record payment (mock)
            </Button>
          )}
        </div>
      </Section>

      {invoice.status !== 'draft' && invoice.status !== 'void' && (
        <Section title="Accounting">
          {acc.syncError && (
            <Notice tone="error" title="Posting failed">
              <p data-testid="sync-error">{acc.syncError.message}</p>
              {acc.syncError.issues.length > 0 && (
                <ul className="list-disc pl-5">
                  {acc.syncError.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}
              {acc.syncError.kind === 'reauthorisation_required' && (
                <p>
                  <a className="text-link" href={href('settings')}>
                    Reconnect in Settings
                  </a>
                </p>
              )}
            </Notice>
          )}
          {acc.warnings.map((warning) => (
            <Notice key={warning} tone="warning">
              {warning}
            </Notice>
          ))}
          <dl className="kvs">
            <div className="kv">
              <dt>Ledger record</dt>
              <dd data-testid="external-id">{acc.externalInvoiceId ?? 'Not posted yet'}</dd>
            </div>
            {acc.providerInvoiceNumber && (
              <div className="kv">
                <dt>Ledger invoice number</dt>
                <dd>{acc.providerInvoiceNumber}</dd>
              </div>
            )}
            {acc.providerStatus && (
              <div className="kv">
                <dt>Ledger status</dt>
                <dd className="capitalize">{acc.providerStatus}</dd>
              </div>
            )}
            {acc.amountPaidCents !== null && (
              <div className="kv">
                <dt>Paid / due</dt>
                <dd data-testid="payment-status">
                  {money(acc.amountPaidCents)} paid · {money(acc.amountDueCents ?? 0)} due
                </dd>
              </div>
            )}
            {acc.lastReconciledAt && (
              <div className="kv">
                <dt>Last checked</dt>
                <dd>{formatDate(acc.lastReconciledAt)}</dd>
              </div>
            )}
          </dl>
          {acc.attempts.length > 0 && (
            <details>
              <summary>Sync attempts ({acc.attempts.length})</summary>
              <ol className="grid gap-1">
                {acc.attempts.map((attempt) => (
                  <li key={`${attempt.attempt}-${attempt.startedAt}`} className="muted">
                    #{attempt.attempt} {attempt.status.replace('_', ' ')}
                    {attempt.errorKind ? ` (${attempt.errorKind.replace('_', ' ')})` : ''} ·{' '}
                    {formatDate(attempt.startedAt)}
                  </li>
                ))}
              </ol>
            </details>
          )}
          <p className="hint">
            Once posted, the accounting system is the ledger of record for payments; OPENTRADIE
            shows its figures and never edits a posted invoice.
          </p>
        </Section>
      )}
    </div>
  );
}

function InvoiceLinesTable({ invoice }: { invoice: Invoice }) {
  const { money } = useWorkspace();
  return (
    <div>
      <table className="lines">
        <caption className="sr-only">Invoice line items</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="num">
              Qty × rate
            </th>
            <th scope="col" className="num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.id}>
              <td>
                {line.description}
                <span className="muted"> · {SOURCE_LABEL[line.sourceType]}</span>
                {line.discountBasisPoints ? (
                  <span className="muted"> · less {formatRate(line.discountBasisPoints)}</span>
                ) : null}
              </td>
              <td className="num nowrap">
                {milliToText(line.quantityMilli)} × {money(line.unitPriceCents)}
              </td>
              <td className="num nowrap strong">{money(line.lineTotalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="totals" aria-label="Invoice totals">
        {invoice.gstRegistered ? (
          <>
            <div>
              <dt>Subtotal (excl. GST)</dt>
              <dd>{money(invoice.subtotalCents)}</dd>
            </div>
            <div>
              <dt>GST ({formatRate(invoice.taxBasisPoints)})</dt>
              <dd>{money(invoice.taxCents)}</dd>
            </div>
            <div className="totals-grand">
              <dt>Total (incl. GST)</dt>
              <dd data-testid="invoice-total">{money(invoice.totalCents)}</dd>
            </div>
          </>
        ) : (
          <div className="totals-grand">
            <dt>Total (no GST)</dt>
            <dd data-testid="invoice-total">{money(invoice.totalCents)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** Owner edits quantities, removes lines or adds a line from an approved rate. */
function DraftEditor({ invoice, onSaved }: { invoice: Invoice; onSaved: () => Promise<void> }) {
  const { state } = useWorkspace();
  const [quantities, setQuantities] = useState(() =>
    Object.fromEntries(invoice.lines.map((line) => [line.id, milliToText(line.quantityMilli)])),
  );
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [rateCode, setRateCode] = useState('');
  const [rateQuantity, setRateQuantity] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [key, setKey] = useState(newIdempotencyKey);

  async function save() {
    setError(null);
    const lines: InvoiceLineEdit[] = [];
    for (const line of invoice.lines) {
      if (removed.has(line.id)) continue;
      const milli = parseQuantityMilli(quantities[line.id] ?? '');
      if (milli === null || milli <= 0)
        return setError(new Error(`Check the quantity for “${line.description}”.`));
      lines.push(
        milli === line.quantityMilli
          ? { lineId: line.id }
          : { lineId: line.id, quantityMilli: milli },
      );
    }
    if (rateCode) {
      const milli = parseQuantityMilli(rateQuantity);
      if (milli === null || milli <= 0) return setError(new Error('Check the new line quantity.'));
      lines.push({ source: 'approved_rate', rateCode, quantityMilli: milli });
    }
    if (!lines.length)
      return setError(new Error('An invoice needs at least one line. Void the draft instead.'));
    setBusy(true);
    try {
      await updateInvoiceLines(invoice.id, invoice.version, lines, key);
      setKey(newIdempotencyKey());
      setRemoved(new Set());
      setRateCode('');
      await onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Edit draft">
      <div className="grid gap-3">
        {invoice.lines.map((line) => (
          <div key={line.id} className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextField
                label={`Quantity · ${line.description}`}
                inputMode="decimal"
                value={quantities[line.id] ?? ''}
                disabled={removed.has(line.id)}
                onChange={(event) =>
                  setQuantities((current) => ({ ...current, [line.id]: event.target.value }))
                }
              />
            </div>
            <Button
              variant="quiet"
              icon={removed.has(line.id) ? 'refresh' : 'close'}
              onClick={() =>
                setRemoved((current) => {
                  const next = new Set(current);
                  if (next.has(line.id)) next.delete(line.id);
                  else next.add(line.id);
                  return next;
                })
              }
            >
              {removed.has(line.id) ? 'Keep' : 'Remove'}
            </Button>
          </div>
        ))}
        <SelectField
          label="Add a line from an approved rate"
          value={rateCode}
          onChange={(event) => setRateCode(event.target.value)}
        >
          <option value="">No new line</option>
          {state.rates.map((rate) => (
            <option key={rate.code} value={rate.code}>
              {rate.label}
            </option>
          ))}
        </SelectField>
        {rateCode && (
          <TextField
            label="New line quantity"
            inputMode="decimal"
            value={rateQuantity}
            onChange={(event) => setRateQuantity(event.target.value)}
          />
        )}
        <p className="hint">
          Removed time and materials become available to invoice again. Prices come only from the
          original source or your approved rates.
        </p>
        {error !== null && <ErrorNotice title="Draft not saved" error={error} />}
        <Button icon="check" busy={busy} disabled={busy} onClick={() => void save()}>
          Save draft
        </Button>
      </div>
    </Section>
  );
}
