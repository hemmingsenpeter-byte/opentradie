import { useState } from 'react';
import type { FormEvent } from 'react';
import { login } from '../api';
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await login(String(form.get('email') ?? '').trim(), String(form.get('password') ?? ''));
      await onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-top">
        <Brand />
        <p className="login-tagline">Jobs, customers and quotes — on the tools, not at the desk.</p>
      </div>
      <div className="hazard" aria-hidden="true" />
      <form className="login-form card" onSubmit={(event) => void submit(event)} noValidate={false}>
        <h1 className="page-title">Sign in</h1>
        {message && !error && <Notice tone="info">{message}</Notice>}
        {error && (
          <Notice tone="error" title="Couldn’t sign you in">
            {error}
          </Notice>
        )}
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
        <p className="hint flex items-start gap-2">
          <Icon name="shield" size={18} />
          <span>
            Your workspace operator issues sign-ins. For the local demo, use the owner or viewer
            credentials that <code>pnpm setup:dev</code> wrote to <code>.env</code>.
          </span>
        </p>
      </form>
    </main>
  );
}
