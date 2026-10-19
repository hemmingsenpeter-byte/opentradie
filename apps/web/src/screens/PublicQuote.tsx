import { useEffect, useState } from 'react';
import { ApiError, decidePublicQuote, getPublicQuote, publicQuotePdfUrl } from '../api';
import { Brand } from '../components/Icons';
import { Button, ErrorNotice, Loading, Notice, TextArea, TextField } from '../components/ui';
import { formatDate } from '../format';
import type { PublicQuote } from '../types';

/** "/q/<token>" → token, or null for any other path. */
export function acceptanceTokenFromPath(pathname: string): string | null {
  const match = /^\/q\/([A-Za-z0-9_-]{43})\/?$/.exec(pathname);
  return match ? match[1]! : null;
}

const GONE: Record<string, { title: string; text: string }> = {
  QUOTE_EXPIRED: {
    title: 'This quote has expired',
    text: 'The validity date has passed. Please contact the business for an updated quote.',
  },
  QUOTE_SUPERSEDED: {
    title: 'This quote has been updated',
    text: 'A newer version replaced it. Please use the link in the most recent message from the business.',
  },
  LINK_NOT_FOUND: {
    title: 'Link not recognised',
    text: 'Check that you opened the whole link from the message you received.',
  },
};

/**
 * Customer page for a sent quote. Works without signing in: the link's token is the only
 * credential. Mobile-first; every amount and label is formatted by the server.
 */
export function PublicQuoteScreen({ token }: { token: string }) {
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    document.title = 'Your quote';
    getPublicQuote(token).then(setQuote, setLoadError);
  }, [token]);

  async function decide(decision: 'accept' | 'decline') {
    if (name.trim().length < 2) {
      setError(new Error('Type your full name to sign.'));
      return;
    }
    setBusy(decision);
    setError(null);
    try {
      setQuote(
        await decidePublicQuote(token, decision, {
          name: name.trim(),
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === 'QUOTE_ALREADY_DECIDED')
        await getPublicQuote(token).then(setQuote, () => undefined);
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const gone = loadError instanceof ApiError ? GONE[loadError.code] : undefined;
  return (
    <main
      className="public-quote stack"
      style={{ maxWidth: 640, margin: '0 auto', padding: '1rem' }}
    >
      <Brand compact />
      {!quote && !loadError && <Loading label="Opening your quote…" />}
      {gone && (
        <Notice tone="warning" title={gone.title}>
          {gone.text}
        </Notice>
      )}
      {loadError !== null && !gone && (
        <ErrorNotice title="The quote didn’t load" error={loadError} />
      )}
      {quote && (
        <>
          <header className="card card-pad">
            <p className="eyebrow">{quote.business.name}</p>
            <h1 className="page-title">
              {quote.title} {quote.quoteNumber}
              {quote.revision > 1 ? ` (version ${quote.revision})` : ''}
            </h1>
            {quote.business.gstNumberLabel && (
              <p className="muted">{quote.business.gstNumberLabel}</p>
            )}
            <p>For {quote.customerName}</p>
            {quote.siteLabel && <p className="muted">{quote.siteLabel}</p>}
            <dl className="kvs">
              {quote.dates.map((date) => (
                <div className="kv" key={date.label}>
                  <dt>{date.label}</dt>
                  <dd>{date.value}</dd>
                </div>
              ))}
            </dl>
          </header>
          <section className="card card-pad" aria-label="Quote lines">
            <ul className="grid gap-3">
              {quote.lines.map((line, index) => (
                <li key={`${line.description}-${index}`} className="flex justify-between gap-3">
                  <span>
                    {line.description}
                    <span className="muted block">
                      {line.quantity} {line.unit} × {line.unitPrice}
                    </span>
                  </span>
                  <strong className="nowrap">{line.amount}</strong>
                </li>
              ))}
            </ul>
            <dl className="totals" data-testid="public-totals">
              {quote.totals.map((row) => (
                <div key={row.label} className={row.emphasis ? 'totals-grand' : undefined}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            <ul className="grid gap-1 hint">
              {quote.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <a className="btn btn-secondary mt-3" href={publicQuotePdfUrl(token)} download>
              Download PDF
            </a>
          </section>
          {quote.decision ? (
            <Notice
              tone={quote.decision.decision === 'accepted' ? 'success' : 'info'}
              title={quote.decision.decision === 'accepted' ? 'Quote accepted' : 'Quote declined'}
            >
              Recorded for {quote.decision.signerName} on {formatDate(quote.decision.decidedAt)}.{' '}
              {quote.decision.decision === 'accepted'
                ? `${quote.business.name} will be in touch to arrange the work.`
                : `Thank you for letting ${quote.business.name} know.`}
            </Notice>
          ) : (
            <section className="card card-pad grid gap-3" aria-label="Your decision">
              <h2 className="section-title">Accept or decline</h2>
              <p className="muted">Valid until {quote.validUntil}.</p>
              <TextField
                label="Your full name"
                hint="Typing your name signs your decision."
                autoComplete="name"
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
              />
              <TextArea
                label="Comment"
                optional
                rows={3}
                maxLength={2000}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
              {error !== null && <ErrorNotice title="Not recorded" error={error} />}
              <Button
                variant="go"
                icon="check"
                block
                busy={busy === 'accept'}
                disabled={busy !== null}
                onClick={() => void decide('accept')}
              >
                Accept quote
              </Button>
              <Button
                variant="stop"
                icon="close"
                block
                busy={busy === 'decline'}
                disabled={busy !== null}
                onClick={() => void decide('decline')}
              >
                Decline
              </Button>
            </section>
          )}
        </>
      )}
    </main>
  );
}
