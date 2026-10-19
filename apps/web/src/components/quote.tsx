import { useState } from 'react';
import {
  ApiError,
  approveQuote,
  newIdempotencyKey,
  quotePdfUrl,
  rejectQuote,
  reviseQuote,
  sendQuote,
} from '../api';
import { navigate, href } from '../router';
import { formatDate, formatRate, milliToText, quoteStatusLabel } from '../format';
import type { Quote, QuoteSendResult } from '../types';
import { useWorkspace } from '../workspace';
import { Icon } from './Icons';
import { Button, Dialog, ErrorNotice, Notice, Pill, TextArea, ViewOnlyNote } from './ui';
import type { Tone } from './ui';

export const quoteTone = (status: string): Tone =>
  status === 'approved' || status === 'accepted'
    ? 'approved'
    : status === 'rejected' || status === 'expired'
      ? 'rejected'
      : status === 'sent'
        ? 'info'
        : status === 'superseded'
          ? 'neutral'
          : 'draft';

export function QuoteStatusPill({ status }: { status: string }) {
  return (
    <Pill tone={quoteTone(status)}>
      <Icon
        name={
          status === 'approved' || status === 'accepted'
            ? 'check'
            : status === 'rejected' || status === 'expired'
              ? 'close'
              : 'quotes'
        }
        size={16}
      />
      {quoteStatusLabel(status)}
    </Pill>
  );
}

const TAX_NOTE: Record<string, string> = { zero_rated: ' · zero-rated', exempt: ' · GST exempt' };

/** Line items and totals exactly as the server calculated them. */
export function QuoteLines({ quote }: { quote: Quote }) {
  const { money } = useWorkspace();
  const registered = quote.gstRegistered ?? true;
  const inclusive = quote.pricesEntered === 'inclusive';
  return (
    <div>
      {quote.lines.length === 0 ? (
        <Notice tone="warning" title="No priced lines">
          No approved rate matched this work, so nothing has been priced. OPENTRADIE never guesses a
          price — add or confirm an approved rate first.
        </Notice>
      ) : (
        <table className="lines">
          <caption className="sr-only">Quote line items</caption>
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
            {quote.lines.map((line, index) => (
              <tr key={`${line.description}-${index}`}>
                <td>
                  {line.description}
                  {registered && line.taxCode && TAX_NOTE[line.taxCode] && (
                    <span className="muted">{TAX_NOTE[line.taxCode]}</span>
                  )}
                  {line.discountBasisPoints ? (
                    <span className="muted"> · less {formatRate(line.discountBasisPoints)}</span>
                  ) : null}
                </td>
                <td className="num nowrap">
                  {line.quantityMilli !== undefined
                    ? milliToText(line.quantityMilli)
                    : line.quantity}{' '}
                  × {money(line.unitPriceCents)}
                </td>
                <td className="num nowrap strong">{money(line.lineTotalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <dl className="totals" aria-label="Quote totals" data-testid="quote-totals">
        {registered ? (
          <>
            <div>
              <dt>Subtotal (excl. GST)</dt>
              <dd data-testid="quote-subtotal">{money(quote.subtotalCents)}</dd>
            </div>
            <div>
              <dt>
                GST
                {quote.taxBasisPoints !== undefined ? ` (${formatRate(quote.taxBasisPoints)})` : ''}
              </dt>
              <dd data-testid="quote-gst">{money(quote.taxCents)}</dd>
            </div>
            <div className="totals-grand">
              <dt>Total (incl. GST)</dt>
              <dd data-testid="quote-total">{money(quote.totalCents)}</dd>
            </div>
          </>
        ) : (
          <div className="totals-grand">
            <dt>Total (no GST)</dt>
            <dd data-testid="quote-total">{money(quote.totalCents)}</dd>
          </div>
        )}
      </dl>
      <p className="hint">
        Calculated by OPENTRADIE from your approved rates and recorded prices
        {registered ? (inclusive ? '; prices include GST' : '; prices exclude GST') : ''}. Totals
        are never typed in.
      </p>
    </div>
  );
}

export function QuoteChecks({ quote }: { quote: Quote }) {
  return (
    <div className="grid gap-4">
      {quote.missingInformation.length > 0 && (
        <div className="checklist checklist-missing">
          <h3 className="sub-title">
            <Icon name="warning" size={20} /> Missing information
          </h3>
          <ul>
            {quote.missingInformation.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {quote.assumptions.length > 0 && (
        <div className="checklist">
          <h3 className="sub-title">
            <Icon name="file" size={20} /> Pricing assumptions
          </h3>
          <ul>
            {quote.assumptions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

type Decision = 'approve' | 'reject';

/** Approve / reject controls. Owners act; viewers see why they cannot. The server decides. */
export function QuoteApproval({ quote }: { quote: Quote }) {
  const { isOwner, reload, money } = useWorkspace();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [done, setDone] = useState<Decision | null>(null);

  if (quote.status !== 'draft')
    return <QuoteSending quote={quote} justApproved={done === 'approve'} />;

  return (
    <div className="approval" aria-label="Approval">
      <h3 className="sub-title">Your decision</h3>
      {isOwner && quote.missingInformation.length > 0 && (
        <p className="hint">
          Check every missing-information item with the customer before approving. The server may
          refuse approval while items are open.
        </p>
      )}
      <div className="approval-buttons">
        <Button
          variant="go"
          icon="check"
          disabled={!isOwner}
          onClick={() => setDecision('approve')}
          aria-describedby={!isOwner ? `viewer-${quote.id}` : undefined}
        >
          Approve quote
        </Button>
        <Button
          variant="stop"
          icon="close"
          disabled={!isOwner}
          onClick={() => setDecision('reject')}
          aria-describedby={!isOwner ? `viewer-${quote.id}` : undefined}
        >
          Reject
        </Button>
      </div>
      {!isOwner && (
        <div id={`viewer-${quote.id}`}>
          <ViewOnlyNote>
            View-only access: only the business owner can approve or reject quotes.
          </ViewOnlyNote>
        </div>
      )}
      {decision && (
        <DecisionDialog
          quote={quote}
          decision={decision}
          total={money(quote.totalCents)}
          onClose={() => setDecision(null)}
          onDone={async () => {
            setDone(decision);
            setDecision(null);
            await reload().catch(() => undefined);
          }}
        />
      )}
    </div>
  );
}

function DecisionDialog({
  quote,
  decision,
  total,
  onClose,
  onDone,
}: {
  quote: Quote;
  decision: Decision;
  total: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { reload } = useWorkspace();
  // One key per dialog: double taps and retries of the same decision are safe.
  const [key] = useState(newIdempotencyKey);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const approve = decision === 'approve';

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      if (approve) await approveQuote(quote.id, quote.version, key);
      else await rejectQuote(quote.id, quote.version, key, reason.trim() || undefined);
      await onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const stale = error instanceof ApiError && error.code === 'STALE_QUOTE';
  return (
    <Dialog title={approve ? 'Approve this quote?' : 'Reject this quote?'} onClose={onClose}>
      <p className="dialog-total">
        <span className="muted">Total incl. GST</span>
        <strong>{total}</strong>
      </p>
      {approve ? (
        <p>
          Approving records your decision and an audit event. It does not send anything to the
          customer.
        </p>
      ) : (
        <TextArea
          label="Reason"
          optional
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          hint="Kept with the audit record."
        />
      )}
      {error !== null && (
        <ErrorNotice
          title={
            error instanceof ApiError && error.status === 403
              ? 'Not allowed'
              : 'The decision was not saved'
          }
          error={error}
          retry={stale ? () => void reload().then(onClose) : undefined}
        />
      )}
      <div className="dialog-actions">
        <Button
          variant={approve ? 'go' : 'stop'}
          icon={approve ? 'check' : 'close'}
          busy={busy}
          disabled={busy || stale}
          onClick={() => void confirm()}
        >
          {approve ? 'Yes, approve' : 'Yes, reject'}
        </Button>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}

/** After approval: send, share the customer link, revise, and show the customer's decision. */
export function QuoteSending({
  quote,
  justApproved = false,
}: {
  quote: Quote;
  justApproved?: boolean;
}) {
  const { isOwner, reload, money } = useWorkspace();
  const [sendKey] = useState(newIdempotencyKey);
  const [reviseKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState<'send' | 'revise' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<QuoteSendResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function send() {
    setBusy('send');
    setError(null);
    try {
      setResult(await sendQuote(quote.id, quote.version, sendKey));
      await reload().catch(() => undefined);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }
  async function revise() {
    setBusy('revise');
    setError(null);
    try {
      const next = await reviseQuote(quote.id, quote.version, reviseKey);
      await reload().catch(() => undefined);
      navigate(href('quotes', next.id));
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  }
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const decision = quote.customerDecision;
  const canRevise = isOwner && (quote.status === 'approved' || quote.status === 'sent');
  return (
    <div className="grid gap-4" aria-label="Sending">
      {quote.status === 'approved' && (
        <Notice tone="success" title="Quote approved">
          This quote is recorded as approved{justApproved ? ' just now' : ''}. Nothing has been sent
          to the customer yet.
        </Notice>
      )}
      {quote.status === 'sent' && (
        <Notice tone="info" title="Sent — waiting for the customer">
          Valid until {quote.validUntil ?? 'the date on the quote'}. The customer can accept or
          decline with the link.
        </Notice>
      )}
      {quote.status === 'accepted' && (
        <Notice tone="success" title="Accepted by the customer">
          {decision
            ? `${decision.signerName} accepted ${money(quote.totalCents)} on ${formatDate(decision.decidedAt)}.`
            : 'The customer accepted this quote.'}
          {decision?.comment && <p className="mt-2">“{decision.comment}”</p>}
        </Notice>
      )}
      {quote.status === 'rejected' && (
        <Notice
          tone="warning"
          title={
            quote.decisionSource === 'customer' ? 'Declined by the customer' : 'Quote rejected'
          }
        >
          {decision
            ? `${decision.signerName} declined on ${formatDate(decision.decidedAt)}.`
            : 'This draft was rejected and will not be sent.'}
          {decision?.comment && <p className="mt-2">“{decision.comment}”</p>}
        </Notice>
      )}
      {quote.status === 'expired' && (
        <Notice tone="warning" title="Expired">
          The validity date passed without a decision.
        </Notice>
      )}
      {quote.status === 'superseded' && (
        <Notice tone="info" title="Superseded">
          A newer version of this quote replaced it; its customer link no longer works.
        </Notice>
      )}

      {isOwner && quote.status === 'approved' && (
        <Button
          variant="primary"
          icon="send"
          busy={busy === 'send'}
          disabled={busy !== null}
          onClick={() => void send()}
        >
          Send to customer
        </Button>
      )}
      {isOwner && quote.status === 'sent' && !result && (
        <Button
          icon="file"
          busy={busy === 'send'}
          disabled={busy !== null}
          onClick={() => void send()}
        >
          Show acceptance link
        </Button>
      )}
      {result && (
        <div className="grid gap-2" data-testid="acceptance-link">
          <p className="hint">
            A message draft with this link was saved to the job. OPENTRADIE has not emailed it: send
            it from your own email or phone.
          </p>
          <input
            readOnly
            aria-label="Acceptance link"
            value={result.acceptanceUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button icon="check" onClick={() => void copy(result.acceptanceUrl)}>
            {copied ? 'Link copied' : 'Copy acceptance link'}
          </Button>
        </div>
      )}
      {quote.pdfDocumentId && (
        <a className="btn btn-secondary" href={quotePdfUrl(quote.id)} download>
          <Icon name="file" />
          <span>Download PDF</span>
        </a>
      )}
      {canRevise && (
        <Button
          icon="edit"
          busy={busy === 'revise'}
          disabled={busy !== null}
          onClick={() => void revise()}
        >
          Revise (new version)
        </Button>
      )}
      {!isOwner && (quote.status === 'approved' || quote.status === 'sent') && (
        <ViewOnlyNote>
          View-only access: only the business owner can send or revise quotes.
        </ViewOnlyNote>
      )}
      {error !== null && <ErrorNotice title="That didn’t work" error={error} />}
    </div>
  );
}
