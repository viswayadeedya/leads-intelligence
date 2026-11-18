import { redirect } from 'next/navigation';
import { signInMockAction, signInPassphraseAction } from '../actions';
import { Field } from '@/components/ui';
import { getConfig, getOptionalActor } from '@/lib/runtime';

const MESSAGES: Record<string, string> = {
  bad: 'That passphrase was not accepted. Check it and try again.',
  rate_limited: 'Too many sign-in attempts. Wait 15 minutes, then try again.',
  passphrase_required: 'A passphrase is configured, so one-click sign-in is turned off. Enter the passphrase.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  if (await getOptionalActor()) redirect('/');
  const { e } = await searchParams;
  const config = getConfig();
  const message = e ? MESSAGES[e] : undefined;
  return (
    <div className="login">
      <h1>Sign in</h1>
      <p className="subtitle">This is a private, single-operator research tool. Everything behind this page requires a session.</p>
      {message ? (
        <div className="notice notice-error" role="alert">
          {message}
        </div>
      ) : null}
      {config.operatorPassphraseSet ? (
        <form action={signInPassphraseAction} className="card">
          <Field label="Operator passphrase" hint="Set as OPERATOR_PASSPHRASE in your untracked .env.local file.">
            <input type="password" name="passphrase" autoComplete="current-password" required />
          </Field>
          <button type="submit" className="btn-primary">
            Sign in
          </button>
        </form>
      ) : (
        <form action={signInMockAction} className="card">
          <p>
            <strong>Mock mode, no passphrase set.</strong> You can sign in with one click because the only data available is synthetic fixtures and whatever you type in yourself.
          </p>
          <p className="muted small">To require a passphrase, set OPERATOR_PASSPHRASE in .env.local and restart. One-click sign-in is then switched off.</p>
          <button type="submit" className="btn-primary">
            Continue as local operator
          </button>
        </form>
      )}
    </div>
  );
}
