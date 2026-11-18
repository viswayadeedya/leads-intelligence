import { redirect } from 'next/navigation';
import { setupAction, signInAction } from '../actions';
import { Field, Time } from '@/components/ui';
import { authStatus, prepareSetup } from '@/lib/auth';
import { getOptionalActor, getSetupSink, getStore } from '@/lib/runtime';

// Fixed messages only. Nothing here says why a secret was wrong.
const MESSAGES: Record<string, string> = {
  bad: 'That was not accepted. Check it and try again. Five failed attempts lock sign-in for 15 minutes.',
  locked: 'Too many failed attempts. Sign-in is locked for up to 15 minutes; then try again.',
  weak: 'That passphrase is not strong enough. Use at least 12 characters, with some variety, and not a common phrase.',
  mismatch: 'The two passphrases did not match. Nothing was saved.',
  unavailable: 'That sign-in method is not available. Reload this page and follow what it shows.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  if (await getOptionalActor()) redirect('/');
  const { e } = await searchParams;
  const now = new Date();
  const store = getStore();
  const setup = prepareSetup(store, process.env, now, getSetupSink());
  const auth = authStatus(store, process.env, now);
  const message = e ? MESSAGES[e] : undefined;
  return (
    <div className="login">
      <h1>{setup.needed ? 'Set up sign-in' : 'Sign in'}</h1>
      <p className="subtitle">This is a private, single-operator research tool. Everything behind this page requires a session.</p>
      {message ? (
        <div className="notice notice-error" role="alert">
          {message}
        </div>
      ) : null}
      {auth.lockedUntil ? (
        <div className="notice notice-error" role="status">
          Sign-in is locked until <Time iso={auth.lockedUntil} /> because of repeated failed attempts.
        </div>
      ) : null}
      {auth.envPassphraseProblem ? (
        <div className="notice notice-error" role="alert">
          OPERATOR_PASSPHRASE is set in the environment but is too weak to be accepted, so nobody can sign in. Remove it from .env.local (to use a stored passphrase) or set a stronger one, then restart.
        </div>
      ) : null}

      {setup.needed ? (
        <form action={setupAction} className="card">
          <p>
            <strong>First run.</strong> To prove you are the person running this app, a one-time setup code was written to a file on this computer:
          </p>
          <p className="mono break">{setup.location}</p>
          <p className="muted small">It is inside the project folder. Open it in any text editor, copy the first line, and paste it below. The file is deleted when setup finishes.</p>
          <Field label="Setup code">
            <input type="text" name="code" autoComplete="off" autoCapitalize="off" spellCheck={false} required />
          </Field>
          <Field label="Choose a passphrase" hint="At least 12 characters. Several unrelated words work well. Only a scrambled (hashed) form is stored.">
            <input type="password" name="passphrase" autoComplete="new-password" minLength={12} maxLength={200} required />
          </Field>
          <Field label="Passphrase again">
            <input type="password" name="confirm" autoComplete="new-password" minLength={12} maxLength={200} required />
          </Field>
          <button type="submit" className="btn-primary">
            Save passphrase and sign in
          </button>
        </form>
      ) : (
        <form action={signInAction} className="card">
          <Field
            label="Operator passphrase"
            hint={auth.mode === 'env_passphrase' ? 'The one set as OPERATOR_PASSPHRASE in your untracked .env.local file.' : 'The one you chose when you set this app up.'}
          >
            <input type="password" name="passphrase" autoComplete="current-password" maxLength={200} required />
          </Field>
          <button type="submit" className="btn-primary">
            Sign in
          </button>
          <p className="muted small">Forgot it? Stop the app and run “npm run auth:reset” in the project folder. That removes the passphrase and all sessions, keeps your research data, and starts setup again.</p>
        </form>
      )}
    </div>
  );
}
