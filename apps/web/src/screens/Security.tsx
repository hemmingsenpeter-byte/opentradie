import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  changePassword,
  confirmTotp,
  disableMfa,
  getAccount,
  listSessions,
  revokeSession,
  startTotp,
  type AccountStatus,
  type SessionInfo,
} from '../account-api';
import { href } from '../router';
import {
  Button,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Section,
  TextField,
} from '../components/ui';

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const field = (event: FormEvent<HTMLFormElement>, name: string) =>
  String(new FormData(event.currentTarget).get(name) ?? '');

/**
 * Settings › Security: change password, TOTP two-factor (manual entry: no QR library is in the
 * dependency tree, so the otpauth URI and base32 secret are shown to type or paste into an
 * authenticator app), recovery codes shown once, and the user's own active sessions.
 */
export function SecurityScreen({ onEnrolled }: { onEnrolled?: () => void } = {}) {
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [setup, setSetup] = useState<{ otpauthUri: string; secret: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [status, list] = await Promise.all([getAccount(), listSessions()]);
      setAccount(status);
      setSessions(list.sessions);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function act(name: string, work: () => Promise<void>) {
    setBusy(name);
    setError(null);
    setMessage('');
    try {
      await work();
    } catch (err) {
      setError(err);
    } finally {
      setBusy('');
    }
  }

  const onChangePassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const current = field(event, 'currentPassword');
    const next = field(event, 'newPassword');
    if (next !== field(event, 'confirmPassword')) {
      setError(new Error('The new passwords do not match.'));
      return;
    }
    void act('password', async () => {
      const result = await changePassword(current, next);
      form.reset();
      setMessage(
        `Password changed. ${result.otherSessionsRevoked} other session(s) were signed out.`,
      );
      await load();
    });
  };

  const onConfirm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = field(event, 'code');
    void act('confirm', async () => {
      const result = await confirmTotp(code);
      setSetup(null);
      setRecoveryCodes(result.recoveryCodes);
      setMessage('Two-factor sign-in is on.');
      await load();
    });
  };

  const onDisable = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = field(event, 'password');
    const code = field(event, 'code');
    void act('disable', async () => {
      await disableMfa(password, code);
      setRecoveryCodes(null);
      setMessage('Two-factor sign-in is off.');
      await load();
    });
  };

  const downloadCodes = () => {
    if (!recoveryCodes) return;
    const blob = new Blob(
      [`OPENTRADIE recovery codes (each works once)\n\n${recoveryCodes.join('\n')}\n`],
      { type: 'text/plain' },
    );
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'opentradie-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  if (!account && !error) return <Loading label="Loading account security…" />;

  return (
    <div className="stack">
      <PageHeader
        title="Security"
        eyebrow="Your account"
        {...(onEnrolled ? {} : { back: { href: href('settings'), label: 'Settings' } })}
      />
      {account?.mfaEnrolmentRequired && (
        <Notice tone="info" title="Two-factor sign-in required">
          This installation requires owners to use two-factor sign-in. Set it up below to continue.
        </Notice>
      )}
      {message && <Notice tone="success">{message}</Notice>}
      {error !== null && <ErrorNotice title="Not changed" error={error} />}

      <Section title="Two-factor sign-in">
        {recoveryCodes && (
          <div className="stack">
            <Notice tone="info" title="Save your recovery codes now">
              Each code signs you in once if you lose your phone. They are shown only this once.
            </Notice>
            <ul className="recovery-codes" aria-label="Recovery codes">
              {recoveryCodes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button onClick={downloadCodes}>Download codes</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setRecoveryCodes(null);
                  onEnrolled?.();
                }}
              >
                I have saved them
              </Button>
            </div>
          </div>
        )}
        {account && !account.mfaEnabled && !setup && !recoveryCodes && (
          <div className="stack">
            <p>
              Ask for a 6-digit code from an authenticator app (such as Google Authenticator,
              1Password or Aegis) as well as your password.
            </p>
            {account.mfaAvailable ? (
              <Button
                variant="primary"
                busy={busy === 'setup'}
                onClick={() => void act('setup', async () => setSetup(await startTotp()))}
              >
                Set up two-factor
              </Button>
            ) : (
              <Notice tone="info">
                Not available: the operator must set CREDENTIAL_ENCRYPTION_KEY on this installation.
              </Notice>
            )}
          </div>
        )}
        {setup && (
          <form className="stack" onSubmit={onConfirm} aria-label="Confirm two-factor">
            <p>
              In your authenticator app, add an account by entering this key (time-based, 6 digits,
              30 seconds). There is no QR code: type or paste the key, or open the link on this
              device.
            </p>
            <p>
              Key:{' '}
              <code data-testid="totp-secret" className="break-all">
                {setup.secret}
              </code>
            </p>
            <p>
              <a className="break-all" href={setup.otpauthUri}>
                Open in an authenticator app on this device
              </a>
            </p>
            <TextField
              label="6-digit code from the app"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              required
              maxLength={7}
            />
            <Button type="submit" variant="primary" busy={busy === 'confirm'}>
              Turn on two-factor
            </Button>
          </form>
        )}
        {account?.mfaEnabled && !recoveryCodes && (
          <form className="stack" onSubmit={onDisable} aria-label="Turn off two-factor">
            <p>
              Two-factor sign-in is on. {account.recoveryCodesRemaining} unused recovery code(s)
              left.
            </p>
            <TextField
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            <TextField
              label="Code from the app, or a recovery code"
              name="code"
              autoComplete="one-time-code"
              required
              maxLength={32}
            />
            <Button type="submit" variant="stop" busy={busy === 'disable'}>
              Turn off two-factor
            </Button>
          </form>
        )}
      </Section>

      <Section title="Change password">
        <form className="stack" onSubmit={onChangePassword} aria-label="Change password">
          <TextField
            label="Current password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
          />
          <TextField
            label="New password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            hint="At least 12 characters. A few unrelated words works well."
            required
            minLength={12}
            maxLength={256}
          />
          <TextField
            label="New password again"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={256}
          />
          <Button type="submit" variant="primary" busy={busy === 'password'}>
            Change password
          </Button>
        </form>
      </Section>

      <Section title="Signed-in devices" count={sessions.length}>
        <ul className="rows" aria-label="Sessions">
          {sessions.map((session) => (
            <li key={session.id} className="row row-static">
              <span className="row-main">
                <span className="row-title">
                  {session.userAgentFamily}
                  {session.current ? ' (this device)' : ''}
                </span>
                <span className="row-sub">
                  Signed in {when(session.createdAt)} · last seen {when(session.lastSeenAt)}
                </span>
              </span>
              {!session.current && (
                <Button
                  variant="quiet"
                  busy={busy === session.id}
                  aria-label={`Sign out ${session.userAgentFamily}, signed in ${when(session.createdAt)}`}
                  onClick={() =>
                    void act(session.id, async () => {
                      await revokeSession(session.id);
                      setMessage('That device was signed out.');
                      await load();
                    })
                  }
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
