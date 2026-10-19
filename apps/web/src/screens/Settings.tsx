import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getHealth } from '../api';
import { Icon } from '../components/Icons';
import {
  Button,
  ErrorNotice,
  Loading,
  MockBadge,
  Notice,
  PageHeader,
  Pill,
  Section,
} from '../components/ui';
import type { Tone } from '../components/ui';
import { formatRate } from '../format';
import type { Health } from '../types';
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
                  <Pill tone={statusTone(health.database)}>{health.database}</Pill>
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
            <Row label="GST">{formatRate(business.taxBasisPoints)}</Row>
            {settings.demoData && (
              <Row label="Data">
                <Pill tone="info">Synthetic demo data</Pill>
              </Row>
            )}
          </dl>
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
