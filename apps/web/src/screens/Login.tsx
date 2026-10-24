import { useState } from 'react';
import type { FormEvent } from 'react';
import { confirmPasswordReset, loginStep, requestPasswordReset, verifyMfa } from '../account-api';
import { Brand, Icon } from '../components/Icons';
import { Button, Notice, TextField } from '../components/ui';

export function LoginScreen({
  message,
  onSignedIn,
}: {
  message?: string;
  onSignedIn: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  // A reset link opens the app at #/reset-password?token=... (the token never reaches a server log).
  const resetToken = /^#\/reset-password\?(.*)$/.exec(window.location.hash)?.[1];
  const [mode, setMode] = useState<'password' | 'mfa' | 'forgot' | 'reset'>(
    resetToken ? 'reset' : 'password',
  );
  const [mfaToken, setMfaToken] = useState('');

  async function run(work: (form: FormData) => Promise<void>, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await work(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  const value = (form: FormData, name: string) => String(form.get(name) ?? '');

  const submit = (event: FormEvent<HTMLFormElement>) =>
    run(async (form) => {
      const result = await loginStep(value(form, 'email').trim(), value(form, 'password'));
      if ('mfaRequired' in result) {
        setMfaToken(result.mfaToken);
        setMode('mfa');
        return;
      }
      await onSignedIn();
    }, event);
  const submitCode = (event: FormEvent<HTMLFormElement>) =>
    run(async (form) => {
      try {
        await verifyMfa(mfaToken, value(form, 'code').trim());
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'MFA_TOKEN_EXPIRED')
          setMode('password');
        throw err;
      }
      await onSignedIn();
    }, event);
  const submitForgot = (event: FormEvent<HTMLFormElement>) =>
    run(async (form) => {
      await requestPasswordReset(value(form, 'email').trim());
      setMode('password');
      setInfo(
        'If that email has an account and this workspace has a mail connection, a reset link is on its way (valid 30 minutes). No email? Ask your operator to run pnpm owner:reset-password.',
      );
    }, event);
  const submitReset = (event: FormEvent<HTMLFormElement>) =>
    run(async (form) => {
      if (value(form, 'newPassword') !== value(form, 'confirmPassword'))
        throw new Error('The new passwords do not match.');
      const token = new URLSearchParams(resetToken ?? '').get('token') ?? '';
      await confirmPasswordReset(token, value(form, 'newPassword'));
      window.location.hash = '#/home';
      setMode('password');
      setInfo('Password changed. Sign in with your new password.');
    }, event);

  const notices = (
    <>
      {message && !error && !info && <Notice tone="info">{message}</Notice>}
      {info && <Notice tone="success">{info}</Notice>}
      {error && (
        <Notice tone="error" title="Couldn’t sign you in">
          {error}
        </Notice>
      )}
    </>
  );

  return (
    <main className="login">
      <div className="login-top">
        <Brand />
        <p className="login-tagline">Jobs, customers and quotes — on the tools, not at the desk.</p>
      </div>
      <div className="hazard" aria-hidden="true" />
      {mode === 'mfa' && (
        <form className="login-form card" onSubmit={(event) => void submitCode(event)}>
          <h1 className="page-title">Two-factor code</h1>
          {notices}
          <TextField
            label="Code from your authenticator app, or a recovery code"
            name="code"
            autoComplete="one-time-code"
            autoFocus
            required
            maxLength={32}
          />
          <Button type="submit" variant="primary" block busy={busy} disabled={busy}>
            {busy ? 'Checking…' : 'Verify'}
          </Button>
          <Button variant="quiet" block onClick={() => setMode('password')}>
            Start again
          </Button>
        </form>
      )}
      {mode === 'forgot' && (
        <form className="login-form card" onSubmit={(event) => void submitForgot(event)}>
          <h1 className="page-title">Reset password</h1>
          {notices}
          <TextField label="Email" name="email" type="email" autoComplete="username" required />
          <Button type="submit" variant="primary" block busy={busy} disabled={busy}>
            Email me a reset link
          </Button>
          <Button variant="quiet" block onClick={() => setMode('password')}>
            Back to sign in
          </Button>
        </form>
      )}
      {mode === 'reset' && (
        <form className="login-form card" onSubmit={(event) => void submitReset(event)}>
          <h1 className="page-title">Choose a new password</h1>
          {notices}
          <TextField
            label="New password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            hint="At least 12 characters."
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
          <Button type="submit" variant="primary" block busy={busy} disabled={busy}>
            Set new password
          </Button>
        </form>
      )}
      {mode === 'password' && (
        <form className="login-form card" onSubmit={(event) => void submit(event)}>
          <h1 className="page-title">Sign in</h1>
          {notices}
          <TextField
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            maxLength={254}
          />
          <TextField
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
          />
          <Button type="submit" variant="primary" block busy={busy} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          <Button variant="quiet" block onClick={() => setMode('forgot')}>
            Forgot password?
          </Button>
          <p className="hint flex items-start gap-2">
            <Icon name="shield" size={18} />
            <span>
              Your workspace operator issues sign-ins. For the local demo, use the owner or viewer
              credentials that <code>pnpm setup:dev</code> wrote to <code>.env</code>.
            </span>
          </p>
        </form>
      )}
    </main>
  );
}
