import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  chooseAccountingOrganisation,
  disconnectAccounting,
  disconnectMail,
  getMailStatus,
  startMailConnection,
  syncMail,
  EXPORT_URL,
  getAccountingStatus,
  getCollectionsSettings,
  getCalendarFeed,
  createCalendarFeed,
  revokeCalendarFeed,
  type CalendarFeedStatus,
  getHealth,
  runCollectionsScan,
  updateCollectionsSettings,
  startAccountingConnection,
  syncAccountingNow,
  updateBusinessSettings,
} from '../api';
import { Icon } from '../components/Icons';
import {
  Button,
  ErrorNotice,
  SelectField,
  TextField,
  ViewOnlyNote,
  Loading,
  MockBadge,
  Notice,
  PageHeader,
  Pill,
  Section,
} from '../components/ui';
import type { Tone } from '../components/ui';
import { basisPointsToText, formatGstNumber, formatRate, parsePercentBasisPoints } from '../format';
import { href } from '../router';
import type {
  AccountingStatus,
  CollectionsSettings,
  FollowUpCustomerStage,
  Health,
  MailStatus,
} from '../types';
import { useWorkspace } from '../workspace';

const PROFILES: Record<string, string> = {
  local: 'Runs on your own machine (e.g. a Mac mini). Business data stays on that machine.',
  cloud: 'Runs on a hosted server with managed storage.',
  hybrid:
    'Your own machine holds the data and runs the app; cloud services are used only where your privacy setting allows.',
};

const PRIVACY: Record<string, { label: string; text: string }> = {
  LOCAL_ONLY: {
    label: 'Local only',
    text: 'No business content goes to hosted AI or embedding services. If local AI is unavailable, the assistant stops rather than falling back to the cloud.',
  },
  APPROVAL_REQUIRED: {
    label: 'Approval required',
    text: 'Hosted AI is used only after you approve each task and the data it would receive.',
  },
  APPROVED_CLOUD: {
    label: 'Approved cloud',
    text: 'Hosted AI providers you configured may be used, with secrets redacted and the least data needed.',
  },
};

const statusTone = (value: string): Tone =>
  value === 'ok'
    ? 'approved'
    : value === 'unavailable' || value === 'error'
      ? 'rejected'
      : 'neutral';

const databaseStatus = (value: string | { status?: unknown }): string =>
  typeof value === 'string' ? value : String(value.status ?? 'unknown');

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function SettingsScreen() {
  const { state, isMockAgent, isOwner, signOut, money } = useWorkspace();
  const { settings, business } = state;
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<unknown>(null);
  const [checking, setChecking] = useState(true);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    setHealthError(null);
    try {
      setHealth(await getHealth());
      setCheckedAt(new Date());
    } catch (error) {
      setHealthError(error);
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void check();
  }, [check]);

  const agentHealth =
    typeof settings.agentHealth === 'string' ? settings.agentHealth : settings.agentHealth.status;
  const privacy = PRIVACY[settings.privacyMode];
  const extraHealth = health
    ? Object.entries(health).filter(
        ([key, value]) =>
          !['status', 'database', 'profile'].includes(key) &&
          ['string', 'number', 'boolean'].includes(typeof value),
      )
    : [];

  return (
    <div className="stack">
      <PageHeader title="Settings" eyebrow="How this workspace is running" />
      <Notice tone="info">
        These values come from the server’s configuration and are read-only here.
      </Notice>

      <div className="grid-2">
        <Section title="Deployment">
          <dl className="kvs">
            <Row label="Profile">
              <strong className="capitalize">{settings.profile}</strong>
              <p className="hint">{PROFILES[settings.profile] ?? 'Custom deployment profile.'}</p>
            </Row>
          </dl>
          <p className="callout">
            <Icon name="server" />
            <span>
              Where OPENTRADIE is hosted is not a setting. Moving between local, cloud and hybrid
              hosting is a separate, guided migration: back up, move the data and credentials,
              verify, then switch over. Ask your operator, and see <code>docs/MIGRATION.md</code>.
            </span>
          </p>
        </Section>

        <Section title="Privacy and AI">
          <dl className="kvs">
            <Row label="Privacy mode">
              <strong>{privacy?.label ?? settings.privacyMode}</strong>
              {privacy && <p className="hint">{privacy.text}</p>}
            </Row>
            <Row label="Agent mode">
              <div className="flex flex-wrap items-center gap-2">
                <strong>
                  {settings.agentMode === 'mock'
                    ? 'Mock (demo parser)'
                    : settings.agentMode === 'openclaw'
                      ? 'OpenClaw gateway'
                      : settings.agentMode}
                </strong>
                {isMockAgent && <MockBadge />}
              </div>
            </Row>
            <Row label="Assistant connection">
              <Pill tone={statusTone(agentHealth)}>
                {agentHealth === 'ok' ? 'Connected' : agentHealth}
              </Pill>
              {typeof settings.agentHealth !== 'string' && settings.agentHealth.message && (
                <p className="hint">{settings.agentHealth.message}</p>
              )}
            </Row>
          </dl>
        </Section>

        <Section
          title="System health"
          action={
            <Button icon="refresh" onClick={() => void check()} disabled={checking}>
              Check
            </Button>
          }
        >
          {checking && !health ? (
            <Loading label="Checking…" />
          ) : healthError !== null ? (
            <ErrorNotice
              title="Health check failed"
              error={healthError}
              retry={() => void check()}
            />
          ) : health ? (
            <dl className="kvs" data-testid="health">
              <Row label="Service">
                <Pill tone={statusTone(health.status)}>{health.status}</Pill>
              </Row>
              {health.database && (
                <Row label="Database">
                  {/* /health reports the database as an object ({ status, ... }) on current servers. */}
                  <Pill tone={statusTone(databaseStatus(health.database))}>
                    {databaseStatus(health.database)}
                  </Pill>
                </Row>
              )}
              {extraHealth.map(([key, value]) => (
                <Row key={key} label={key}>
                  {String(value)}
                </Row>
              ))}
              {checkedAt && <Row label="Checked">{checkedAt.toLocaleTimeString('en-NZ')}</Row>}
            </dl>
          ) : null}
        </Section>

        <Section title="Business">
          <dl className="kvs">
            <Row label="Name">{business.name}</Row>
            <Row label="Currency">{business.currency}</Row>
            <Row label="Time zone">{business.timeZone}</Row>
            <Row label="GST">
              {business.gstRegistered === false
                ? 'Not registered'
                : `${formatRate(business.taxBasisPoints)} · No. ${formatGstNumber(business.gstNumber) || 'not set'}`}
            </Row>
            {settings.demoData && (
              <Row label="Data">
                <Pill tone="info">Synthetic demo data</Pill>
              </Row>
            )}
          </dl>
        </Section>

        <Section title="GST, quoting and invoicing">
          <GstSettings />
        </Section>

        <Section title="Mail">
          <MailSettings />
        </Section>
        <Section title="Accounting">
          <AccountingSettings />
        </Section>
        <Section title="Payment follow-ups">
          <FollowUpSettings />
        </Section>
        <Section title="Calendar feed">
          <CalendarFeedSettings />
        </Section>

        <Section title="Approved rates" count={state.rates.length}>
          {state.rates.length ? (
            <ul className="rows">
              {state.rates.map((rate) => (
                <li key={rate.code} className="row row-static">
                  <span className="row-main">
                    <span className="row-title">{rate.label}</span>
                    <span className="row-sub">{rate.code}</span>
                  </span>
                  <span className="row-amount">{money(rate.unitPriceCents)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No approved rates. The assistant cannot price work until rates are approved.
            </p>
          )}
        </Section>

        <Section title="Your data">
          <div className="grid gap-3">
            <p className="muted">
              Download every customer, property, job, note, quote and history record as one JSON
              file. Photos and documents are listed with checksums; their files stay in storage.
              Passwords and connection secrets are never included.
            </p>
            {isOwner ? (
              <a className="btn btn-secondary" href={EXPORT_URL} download>
                <Icon name="file" />
                <span>Export business data</span>
              </a>
            ) : (
              <p className="muted">Only the business owner can export data.</p>
            )}
          </div>
        </Section>

        <Section title="Account">
          <dl className="kvs">
            <Row label="Signed in as">{state.user.email}</Row>
            <Row label="Access">
              {isOwner ? 'Owner — can create, edit and approve' : 'View only'}
            </Row>
          </dl>
          <Button
            icon="logout"
            busy={signingOut}
            onClick={() => {
              setSigningOut(true);
              void signOut();
            }}
          >
            Sign out
          </Button>
        </Section>
      </div>
    </div>
  );
}

/** Owner-editable GST registration, number and price entry; validated again by the server. */
function GstSettings() {
  const { state, isOwner, reload } = useWorkspace();
  const business = state.business;
  const [registered, setRegistered] = useState(business.gstRegistered !== false);
  const [gstNumber, setGstNumber] = useState(formatGstNumber(business.gstNumber));
  const [pricesEntered, setPricesEntered] = useState(business.pricesEntered ?? 'exclusive');
  const [validity, setValidity] = useState(String(business.quoteValidityDays ?? 30));
  const [markup, setMarkup] = useState(
    basisPointsToText(business.defaultMaterialMarkupBasisPoints ?? 0),
  );
  const [terms, setTerms] = useState(String(business.paymentTermsDays ?? 20));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setError(null);
    setSaved(false);
    const termDays = Number.parseInt(terms, 10);
    if (!/^\d+$/.test(terms.trim()) || termDays < 0 || termDays > 365)
      return setError(new Error('Payment terms must be 0 to 365 days.'));
    const days = Number.parseInt(validity, 10);
    const markupBp = parsePercentBasisPoints(markup || '0');
    if (!Number.isInteger(days) || days < 1 || days > 365)
      return setError(new Error('Quote validity must be 1 to 365 days.'));
    if (markupBp === null) return setError(new Error('Markup must be a percentage, e.g. 20.'));
    setBusy(true);
    try {
      await updateBusinessSettings({
        gstRegistered: registered,
        gstNumber: gstNumber.trim() ? gstNumber.trim() : null,
        pricesEntered,
        quoteValidityDays: days,
        defaultMaterialMarkupBasisPoints: markupBp,
        paymentTermsDays: termDays,
      });
      await reload();
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={registered}
          disabled={!isOwner}
          onChange={(event) => setRegistered(event.target.checked)}
        />
        <span>Registered for GST</span>
      </label>
      <TextField
        label="GST number"
        hint="Checked against the IRD check digit. Shown on quotes and tax invoices."
        value={gstNumber}
        disabled={!isOwner || !registered}
        inputMode="numeric"
        onChange={(event) => setGstNumber(event.target.value)}
      />
      <SelectField
        label="Prices are entered"
        value={pricesEntered}
        disabled={!isOwner || !registered}
        onChange={(event) => setPricesEntered(event.target.value as 'exclusive' | 'inclusive')}
      >
        <option value="exclusive">Excluding GST</option>
        <option value="inclusive">Including GST</option>
      </SelectField>
      <TextField
        label="Quotes valid for (days)"
        inputMode="numeric"
        value={validity}
        disabled={!isOwner}
        onChange={(event) => setValidity(event.target.value)}
      />
      <TextField
        label="Default material markup (%)"
        inputMode="decimal"
        value={markup}
        disabled={!isOwner}
        onChange={(event) => setMarkup(event.target.value)}
      />
      <TextField
        label="Invoice payment terms (days)"
        hint="Due date = invoice date + this many days."
        inputMode="numeric"
        value={terms}
        disabled={!isOwner}
        onChange={(event) => setTerms(event.target.value)}
      />
      <p className="hint">
        Existing quotes and invoices keep the GST settings they were priced with; revise a quote to
        re-price it.
      </p>
      {error !== null && <ErrorNotice title="Settings not saved" error={error} />}
      {saved && <Notice tone="success">Settings saved.</Notice>}
      {isOwner ? (
        <Button
          variant="primary"
          icon="check"
          busy={busy}
          disabled={busy}
          onClick={() => void save()}
        >
          Save settings
        </Button>
      ) : (
        <ViewOnlyNote>Only the business owner can change GST settings.</ViewOnlyNote>
      )}
    </div>
  );
}

const ACCOUNTING_OUTCOMES: Record<string, { tone: 'success' | 'warning' | 'error'; text: string }> =
  {
    connected: { tone: 'success', text: 'Accounting connected.' },
    choose_organisation: {
      tone: 'warning',
      text: 'Connected. Choose which organisation OPENTRADIE should post to.',
    },
    denied: { tone: 'warning', text: 'The connection was cancelled at the provider.' },
    invalid_state: {
      tone: 'error',
      text: 'That connection link expired or was already used. Start again.',
    },
    failed: { tone: 'error', text: 'The provider refused the connection. Start again.' },
  };

function AccountingSettings() {
  const { isOwner } = useWorkspace();
  const [status, setStatus] = useState<AccountingStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const outcome = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('accounting');
  const load = useCallback(async () => {
    try {
      setStatus(await getAccountingStatus());
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(name: string, run: () => Promise<unknown>, done?: string) {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      await run();
      await load();
      if (done) setMessage(done);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function connect() {
    setBusy('connect');
    setError(null);
    try {
      const { authorizeUrl } = await startAccountingConnection();
      window.location.assign(authorizeUrl);
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  }

  if (!status) return error !== null ? <ErrorNotice error={error} /> : <Loading />;
  const result = outcome ? ACCOUNTING_OUTCOMES[outcome] : undefined;
  if (status.provider === 'none')
    return (
      <p className="muted">
        No accounting provider is configured on this server (ACCOUNTING_PROVIDER). Approved invoices
        stay in OPENTRADIE.
      </p>
    );
  return (
    <div className="grid gap-3">
      {status.mock && (
        <Notice tone="warning" title="Mock accounting adapter">
          This server uses OPENTRADIE’s fake accounting adapter for demos and tests. It is not Xero
          and proves nothing about a real integration.
        </Notice>
      )}
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
      <dl className="kvs">
        <Row label="Provider">{status.label}</Row>
        <Row label="Connection">
          <Pill
            tone={
              status.status === 'connected'
                ? 'approved'
                : status.status === 'error'
                  ? 'rejected'
                  : 'neutral'
            }
          >
            <span data-testid="accounting-status">{status.status}</span>
          </Pill>
          {status.statusReason === 'reauthorisation_required' && (
            <p className="hint">
              The connection expired or was revoked. Reconnect to resume posting.
            </p>
          )}
        </Row>
      </dl>
      {status.pendingOrganisations.length > 0 && isOwner && (
        <div className="grid gap-2">
          <p>Choose the organisation to post invoices to:</p>
          {status.pendingOrganisations.map((org) => (
            <Button
              key={org.organisationId}
              disabled={busy !== null}
              onClick={() =>
                void act(
                  'org',
                  () => chooseAccountingOrganisation(org.organisationId),
                  'Organisation chosen.',
                )
              }
            >
              {org.name}
            </Button>
          ))}
        </div>
      )}
      {status.syncFailures.length > 0 && (
        <Notice tone="error" title="Invoices that failed to post">
          <ul className="grid gap-1">
            {status.syncFailures.map((failure) => (
              <li key={failure.invoiceId}>
                <a className="text-link" href={href('invoices', failure.invoiceId)}>
                  {failure.invoiceNumber}
                </a>{' '}
                — {failure.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {message && <Notice tone="success">{message}</Notice>}
      {error !== null && <ErrorNotice error={error} />}
      {isOwner ? (
        <div className="flex flex-wrap gap-3">
          {status.status !== 'connected' ? (
            <Button
              variant="primary"
              icon="refresh"
              busy={busy === 'connect'}
              disabled={busy !== null}
              onClick={() => void connect()}
            >
              {status.status === 'error' ? 'Reconnect' : 'Connect'}{' '}
              {status.mock ? 'mock accounting' : 'Xero'}
            </Button>
          ) : (
            <>
              <Button
                icon="refresh"
                busy={busy === 'sync'}
                disabled={busy !== null}
                onClick={() =>
                  void act('sync', () => syncAccountingNow(), 'Payment status refreshed.')
                }
              >
                Sync now
              </Button>
              <Button
                variant="stop"
                icon="close"
                disabled={busy !== null}
                onClick={() =>
                  void act('disconnect', () => disconnectAccounting(), 'Disconnected.')
                }
              >
                Disconnect
              </Button>
            </>
          )}
        </div>
      ) : (
        <ViewOnlyNote>Only the business owner can connect accounting.</ViewOnlyNote>
      )}
      <p className="hint">
        OPENTRADIE posts approved invoices as drafts and reads payments back. The accounting system
        stays the ledger of record.
      </p>
    </div>
  );
}

const MAIL_OUTCOMES: Record<string, { tone: 'success' | 'warning' | 'error'; text: string }> = {
  connected: { tone: 'success', text: 'Mailbox connected.' },
  denied: { tone: 'warning', text: 'The connection was cancelled at the provider.' },
  invalid_state: {
    tone: 'error',
    text: 'That connection link expired or was already used. Start again.',
  },
  failed: { tone: 'error', text: 'The provider refused the connection. Start again.' },
};

const MAIL_NAMES: Record<MailStatus['provider'], string> = {
  none: 'mailbox',
  gmail: 'Gmail',
  microsoft_graph: 'Microsoft 365',
  fake: 'mock mailbox',
};

function MailSettings() {
  const { isOwner } = useWorkspace();
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const outcome = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('mail');
  const load = useCallback(async () => {
    try {
      setStatus(await getMailStatus());
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!status) return error !== null ? <ErrorNotice error={error} /> : <Loading />;
  if (status.provider === 'none')
    return (
      <p className="muted">
        No mailbox provider is configured on this server (MAIL_PROVIDER). Approved replies cannot be
        sent from OPENTRADIE; copy them into your email app.
      </p>
    );
  const name = MAIL_NAMES[status.provider];
  const result = outcome ? MAIL_OUTCOMES[outcome] : undefined;

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl } = await startMailConnection(status!.provider);
      window.location.assign(authorizeUrl);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  async function syncNow() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await syncMail();
      await load();
      setMessage(
        result.outcome === 'reauthorisation_required'
          ? 'The mailbox needs to be connected again.'
          : result.outcome === 'cursor_initialised'
            ? 'Mailbox sync started. New mail from now on will appear in the inbox.'
            : `Mailbox checked: ${result.imported} new message${result.imported === 1 ? '' : 's'}.`,
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await disconnectMail(status!.provider);
      await load();
      setMessage('Mailbox disconnected.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      {status.mock && (
        <Notice tone="warning" title="Mock mailbox">
          This server uses OPENTRADIE’s fake mailbox for demos and tests. Nothing is sent to anyone,
          and it proves nothing about Gmail or Microsoft 365.
        </Notice>
      )}
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
      <dl className="kvs">
        <Row label="Provider">
          {status.label} {status.mock && <MockBadge />}
        </Row>
        <Row label="Connection">
          <Pill
            tone={
              status.status === 'connected'
                ? 'approved'
                : status.status === 'error'
                  ? 'rejected'
                  : 'neutral'
            }
          >
            <span data-testid="mail-status">{status.status}</span>
          </Pill>
          {status.statusReason === 'reauthorisation_required' && (
            <p className="hint">
              The mailbox connection expired or was revoked. Reconnect, then approve unsent replies
              again.
            </p>
          )}
        </Row>
        <Row label="Last checked">
          <span data-testid="mail-last-synced">
            {status.lastSyncedAt
              ? new Date(status.lastSyncedAt).toLocaleString('en-NZ')
              : 'Not yet'}
          </span>
        </Row>
      </dl>
      {message && <Notice tone="success">{message}</Notice>}
      {error !== null && <ErrorNotice error={error} />}
      {isOwner ? (
        <div className="flex flex-wrap gap-3">
          {status.status !== 'connected' ? (
            <Button
              variant="primary"
              icon="refresh"
              busy={busy}
              disabled={busy}
              onClick={() => void connect()}
            >
              {status.status === 'error' ? 'Reconnect' : 'Connect'} {name}
            </Button>
          ) : (
            <>
              <Button icon="refresh" busy={busy} disabled={busy} onClick={() => void syncNow()}>
                Sync now
              </Button>
              <Button variant="stop" icon="close" disabled={busy} onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </>
          )}
        </div>
      ) : (
        <ViewOnlyNote>Only the business owner can connect a mailbox.</ViewOnlyNote>
      )}
      <p className="hint">
        OPENTRADIE sends only replies you approved, from your own mailbox. It asks for permission to
        read and send mail, nothing broader. New inbox mail is checked every 5 minutes.
      </p>
    </div>
  );
}

const STAGE_FIELDS: {
  stage: FollowUpCustomerStage;
  label: string;
  days: 'preDueDays' | 'overdue1Days' | 'overdue2Days' | 'overdueFinalDays';
  dayHint: string;
}[] = [
  {
    stage: 'pre_due_courtesy',
    label: 'Courtesy reminder',
    days: 'preDueDays',
    dayHint: 'days before due',
  },
  { stage: 'overdue_1', label: 'First reminder', days: 'overdue1Days', dayHint: 'days overdue' },
  { stage: 'overdue_2', label: 'Second reminder', days: 'overdue2Days', dayHint: 'days overdue' },
  {
    stage: 'overdue_final',
    label: 'Final reminder',
    days: 'overdueFinalDays',
    dayHint: 'days overdue',
  },
];

/** Owner policy for unpaid invoice follow-ups (ADR 0027); the server validates it again. */
function FollowUpSettings() {
  const { isOwner } = useWorkspace();
  const [policy, setPolicy] = useState<CollectionsSettings | null>(null);
  const [days, setDays] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const adopt = (loaded: CollectionsSettings) => {
    setPolicy(loaded);
    setDays({
      preDueDays: String(loaded.preDueDays),
      overdue1Days: String(loaded.overdue1Days),
      overdue2Days: String(loaded.overdue2Days),
      overdueFinalDays: String(loaded.overdueFinalDays),
      escalateDays: String(loaded.escalateDays),
    });
  };
  useEffect(() => {
    getCollectionsSettings().then(adopt, setError);
  }, []);

  if (!policy) return error !== null ? <ErrorNotice error={error} /> : <Loading />;
  const current = policy;
  const autoStages = STAGE_FIELDS.filter(({ stage }) => current.autoSend[stage]);

  async function save() {
    setError(null);
    setMessage(null);
    const parsed: Record<string, number> = {};
    for (const [key, value] of Object.entries(days)) {
      if (!/^\d+$/.test(value.trim()) || Number(value) < 1 || Number(value) > 365)
        return setError(new Error('Each stage must be 1 to 365 days.'));
      parsed[key] = Number(value);
    }
    setBusy('save');
    try {
      adopt(
        await updateCollectionsSettings({
          enabled: current.enabled,
          preDueCourtesyEnabled: current.preDueCourtesyEnabled,
          autoSend: current.autoSend,
          ...parsed,
        }),
      );
      setMessage('Follow-up settings saved.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function scan() {
    setBusy('scan');
    setError(null);
    setMessage(null);
    try {
      await runCollectionsScan();
      setMessage('Follow-up check queued. New drafts appear in the Inbox for approval.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-3" data-testid="follow-up-settings">
      <p className="muted">
        Prepares polite reminder emails for posted invoices that are still unpaid, using the payment
        status read back from accounting. Every reminder waits in the Inbox for your approval unless
        you turn on auto-send for that stage.
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={current.enabled}
          disabled={!isOwner}
          onChange={(event) => setPolicy({ ...current, enabled: event.target.checked })}
        />
        <span>Prepare payment follow-ups</span>
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={current.preDueCourtesyEnabled}
          disabled={!isOwner}
          onChange={(event) =>
            setPolicy({ ...current, preDueCourtesyEnabled: event.target.checked })
          }
        />
        <span>Send a courtesy reminder before the due date</span>
      </label>
      {STAGE_FIELDS.map(({ stage, label, days: field, dayHint }) => (
        <fieldset key={stage} className="grid gap-2">
          <TextField
            label={`${label} (${dayHint})`}
            inputMode="numeric"
            value={days[field] ?? ''}
            disabled={!isOwner || (stage === 'pre_due_courtesy' && !current.preDueCourtesyEnabled)}
            onChange={(event) => setDays({ ...days, [field]: event.target.value })}
          />
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={current.autoSend[stage]}
              disabled={!isOwner}
              onChange={(event) =>
                setPolicy({
                  ...current,
                  autoSend: { ...current.autoSend, [stage]: event.target.checked },
                })
              }
            />
            <span>Auto-send {label.toLowerCase()} without my approval</span>
          </label>
        </fieldset>
      ))}
      <TextField
        label="Tell me to follow up personally (days overdue)"
        hint="Creates a task for you; no email is sent to the customer."
        inputMode="numeric"
        value={days.escalateDays ?? ''}
        disabled={!isOwner}
        onChange={(event) => setDays({ ...days, escalateDays: event.target.value })}
      />
      {autoStages.length > 0 ? (
        <Notice tone="warning" title="Auto-send is on">
          {autoStages.map(({ label }) => label).join(', ')}: sent from your connected mailbox
          without asking you first. Saving this is a standing approval recorded against you. Each
          send still re-checks the invoice and stops if it was paid, voided or put on hold.
        </Notice>
      ) : (
        <p className="hint">Every follow-up needs your approval before it is sent (default).</p>
      )}
      {message && <Notice tone="success">{message}</Notice>}
      {error !== null && <ErrorNotice title="Follow-ups not updated" error={error} />}
      {isOwner ? (
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            icon="check"
            busy={busy === 'save'}
            disabled={busy !== null}
            onClick={() => void save()}
          >
            Save follow-up settings
          </Button>
          <Button
            icon="refresh"
            busy={busy === 'scan'}
            disabled={busy !== null || !current.enabled}
            onClick={() => void scan()}
          >
            Run follow-up check now
          </Button>
        </div>
      ) : (
        <ViewOnlyNote>Only the business owner can change payment follow-ups.</ViewOnlyNote>
      )}
    </div>
  );
}

/** Private ICS feed link: shown once when created or rotated; revoking stops it at once. */
function CalendarFeedSettings() {
  const { isOwner } = useWorkspace();
  const [status, setStatus] = useState<CalendarFeedStatus | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    try {
      setStatus(await getCalendarFeed());
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    if (isOwner) void load();
  }, [isOwner, load]);

  if (!isOwner)
    return <ViewOnlyNote>Only the business owner can manage the calendar feed.</ViewOnlyNote>;
  if (!status) return error !== null ? <ErrorNotice error={error} /> : <Loading />;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3" data-testid="calendar-feed">
      <p className="muted">
        Subscribe from Apple, Google or Outlook calendar to see your appointments. The feed shows
        job titles and times only, never customer names or addresses. Anyone with the link can read
        it, so treat it like a password.
      </p>
      <p>
        <Pill tone={status.active ? 'approved' : 'neutral'}>
          {status.active ? 'Link active' : 'No link'}
        </Pill>
        {status.lastUsedAt && (
          <span className="hint">
            {' '}
            Last read {new Date(status.lastUsedAt).toLocaleString('en-NZ')}
          </span>
        )}
      </p>
      {url && (
        <Notice tone="warning" title="Copy this link now">
          <code className="break-all" data-testid="calendar-feed-url">
            {url}
          </code>
          <p className="hint">It is shown only once. Rotate the link if you lose it.</p>
          <Button
            icon="file"
            onClick={() =>
              void navigator.clipboard?.writeText(url).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </Notice>
      )}
      {error !== null && <ErrorNotice error={error} />}
      <div className="flex flex-wrap gap-3">
        <Button
          variant="primary"
          icon="refresh"
          busy={busy}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setUrl((await createCalendarFeed()).url);
            })
          }
        >
          {status.active ? 'Rotate link' : 'Create feed link'}
        </Button>
        {status.active && (
          <Button
            variant="stop"
            icon="close"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await revokeCalendarFeed();
                setUrl(null);
              })
            }
          >
            Revoke link
          </Button>
        )}
      </div>
    </div>
  );
}
