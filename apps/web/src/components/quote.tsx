import { useState } from 'react';
import { ApiError, approveQuote, newIdempotencyKey, rejectQuote } from '../api';
import { formatRate, quoteStatusLabel } from '../format';
import type { Quote } from '../types';
import { useWorkspace } from '../workspace';
import { Icon } from './Icons';
import { Button, Dialog, ErrorNotice, Notice, Pill, TextArea, ViewOnlyNote } from './ui';
import type { Tone } from './ui';

export const quoteTone = (status: string): Tone =>
  status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'draft';

export function QuoteStatusPill({ status }: { status: string }) {
  return (
    <Pill tone={quoteTone(status)}>
      <Icon
        name={status === 'approved' ? 'check' : status === 'rejected' ? 'close' : 'quotes'}
        size={16}
      />
      {quoteStatusLabel(status)}
    </Pill>
  );
}

/** Line items and totals exactly as the server calculated them. */
export function QuoteLines({ quote }: { quote: Quote }) {
  const { money } = useWorkspace();
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
                <td>{line.description}</td>
                <td className="num nowrap">
                  {line.quantity} × {money(line.unitPriceCents)}
                </td>
                <td className="num nowrap strong">{money(line.lineTotalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <dl className="totals" aria-label="Quote totals">
        <div>
          <dt>Subtotal</dt>
          <dd>{money(quote.subtotalCents)}</dd>
        </div>
        <div>
          <dt>
            GST{quote.taxBasisPoints !== undefined ? ` (${formatRate(quote.taxBasisPoints)})` : ''}
          </dt>
          <dd>{money(quote.taxCents)}</dd>
        </div>
        <div className="totals-grand">
          <dt>Total</dt>
          <dd data-testid="quote-total">{money(quote.totalCents)}</dd>
        </div>
      </dl>
      <p className="hint">
        Calculated by OPENTRADIE from your approved rates. Amounts are not editable here.
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

  if (quote.status === 'approved') {
    return (
      <Notice tone="success" title="Quote approved">
        This quote is recorded as approved{done === 'approve' ? ' just now' : ''}. Nothing has been
        sent to the customer.
      </Notice>
    );
  }
  if (quote.status === 'rejected') {
    return (
      <Notice tone="warning" title="Quote rejected">
        This draft was rejected and will not be sent.
      </Notice>
    );
  }

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
