import { useCallback, useEffect, useState } from 'react';
import { ApiError, createInvoiceForJob, listInvoices, newIdempotencyKey } from '../api';
import { href, navigate } from '../router';
import type { Invoice, InvoiceStatus } from '../types';
import { useWorkspace } from '../workspace';
import { Icon } from './Icons';
import { Button, Empty, ErrorNotice, Notice, Pill, Section, ViewOnlyNote } from './ui';
import type { Tone } from './ui';

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  approved: 'Approved',
  posting: 'Posting…',
  posted: 'Posted',
  sync_failed: 'Sync failed',
  void: 'Void',
  paid: 'Paid',
  part_paid: 'Part paid',
};

export const invoiceTone = (status: InvoiceStatus): Tone =>
  status === 'paid' || status === 'posted'
    ? 'approved'
    : status === 'sync_failed' || status === 'void'
      ? 'rejected'
      : status === 'approved' || status === 'posting' || status === 'part_paid'
        ? 'info'
        : 'draft';

export function InvoiceStatusPill({ status }: { status: InvoiceStatus }) {
  return (
    <Pill tone={invoiceTone(status)}>
      <Icon
        name={
          status === 'paid' || status === 'posted'
            ? 'check'
            : status === 'sync_failed'
              ? 'warning'
              : 'file'
        }
        size={16}
      />
      <span data-testid="invoice-status">{INVOICE_STATUS_LABEL[status]}</span>
    </Pill>
  );
}

/** "2026-10-20" → "20 Oct 2026" without time-zone shifts. */
export function formatDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

export function InvoiceRow({ invoice }: { invoice: Invoice }) {
  const { money } = useWorkspace();
  return (
    <li>
      <a className="row" href={href('invoices', invoice.id)}>
        <span className="row-main">
          <span className="row-title">
            {invoice.invoiceNumber} · {invoice.jobTitle}
          </span>
          <span className="row-sub">
            {invoice.customerName} · due {formatDay(invoice.dueDate)} ·{' '}
            <InvoiceStatusPill status={invoice.status} />
          </span>
        </span>
        <span className="row-amount">{money(invoice.totalCents)}</span>
        <Icon name="chevron" className="row-chevron" />
      </a>
    </li>
  );
}

/** Job card panel: the job's invoices and, for a completed job, "Create invoice". */
export function JobInvoicesPanel({ jobId, completed }: { jobId: string; completed: boolean }) {
  const { isOwner, state } = useWorkspace();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const acceptedQuote = state.quotes.some(
    (quote) => quote.jobId === jobId && quote.status === 'accepted',
  );
  const load = useCallback(async () => {
    try {
      setInvoices((await listInvoices({ jobId })).invoices);
    } catch (err) {
      setError(err);
    }
  }, [jobId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const invoice = await createInvoiceForJob(jobId, {}, key);
      navigate(href('invoices', invoice.id));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const live = (invoices ?? []).filter((invoice) => invoice.status !== 'void');
  return (
    <Section title="Invoices" count={live.length}>
      <div className="grid gap-3">
        {live.length ? (
          <ul className="rows">
            {live.map((invoice) => (
              <InvoiceRow key={invoice.id} invoice={invoice} />
            ))}
          </ul>
        ) : (
          <Empty icon="file" title="No invoices for this job">
            {completed
              ? acceptedQuote
                ? 'The invoice will copy the accepted quote.'
                : 'The invoice will use recorded time (approved rates) and priced materials.'
              : 'Mark the job completed to invoice it.'}
          </Empty>
        )}
        {error !== null && (
          <ErrorNotice
            title={
              error instanceof ApiError && error.code === 'NOTHING_TO_INVOICE'
                ? 'Nothing to invoice'
                : 'Invoice not created'
            }
            error={error}
          />
        )}
        {completed &&
          (isOwner ? (
            <Button
              variant="primary"
              icon="plus"
              busy={busy}
              disabled={busy}
              onClick={() => void create()}
            >
              Create invoice
            </Button>
          ) : (
            <ViewOnlyNote>Only the business owner can create invoices.</ViewOnlyNote>
          ))}
        {completed && (
          <Notice tone="info">
            Every amount comes from the accepted quote, your approved rates or recorded material
            costs. Time and materials already on an invoice are never billed twice.
          </Notice>
        )}
      </div>
    </Section>
  );
}
