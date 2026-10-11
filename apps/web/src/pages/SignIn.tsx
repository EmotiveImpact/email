import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { auth, ApiError, meQuery } from '../api.ts';
import { Button, Notice } from '../components/ui.tsx';
import { brandVars } from '../theme.ts';

/** The standard look around the signed-out screens. */
export function Welcome({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode }) {
  return (
    <div style={brandVars() as CSSProperties} className="grid min-h-full place-items-center bg-canvas p-4">
      <div className="w-full max-w-[400px] rounded-[20px] border border-rule bg-paper p-8 shadow-[0_1px_2px_#0000000A]">
        <div className="display mb-6 flex size-10 items-center justify-center rounded-xl bg-accent text-xl text-on-accent">N</div>
        <h1 className="display m-0 text-[28px] leading-tight">{title}</h1>
        <p className="mt-2 mb-6 text-sm leading-relaxed text-muted">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, ...props }: { label: string } & React.ComponentProps<'input'>) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] font-medium">
      {label}
      <input
        {...props}
        className="h-10 rounded-[10px] border border-rule-strong bg-paper px-3 font-[inherit] text-sm font-normal text-ink outline-none placeholder:text-faint focus:border-ink"
      />
    </label>
  );
}

export function SignIn() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email'));
    const password = String(form.get('password'));
    setBusy(true);
    setError(null);
    try {
      if (mode === 'in') await auth.signIn(email, password);
      else await auth.signUp(String(form.get('name')), email, password);
      client.clear();
      await navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof ApiError && err.status !== 0 ? friendly(err) : err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Welcome
      title={mode === 'in' ? 'Welcome back' : 'Create your login'}
      subtitle={mode === 'in' ? 'Sign in to see your sending, your clients and what to send next.' : 'Email that knows your diary. It takes a minute to set up.'}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {mode === 'up' && <Field label="Your name" name="name" autoComplete="name" required />}
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} minLength={10} required />
        {error && <Notice tone="bad">{error}</Notice>}
        <Button type="submit" disabled={busy} className="mt-1 h-10">
          {busy ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create login'}
        </Button>
      </form>
      <p className="mt-5 mb-0 text-center text-[13px] text-muted">
        {mode === 'in' ? 'New here?' : 'Already have a login?'}{' '}
        <button type="button" onClick={() => setMode(mode === 'in' ? 'up' : 'in')} className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] font-semibold text-ink underline">
          {mode === 'in' ? 'Create a login' : 'Sign in'}
        </button>
      </p>
    </Welcome>
  );
}

function friendly(err: ApiError) {
  if (err.code === 'INVALID_EMAIL_OR_PASSWORD') return 'That email and password do not match.';
  if (err.code === 'USER_ALREADY_EXISTS' || err.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') return 'There is already a login for that email. Sign in instead.';
  if (err.code === 'PASSWORD_TOO_SHORT') return 'Use at least 10 characters for the password.';
  return err.message;
}

/** First run (or "Add a business"): makes an account if the person has none, then a business. */
export function Setup() {
  const { data: me } = useQuery(meQuery);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const business = String(form.get('business')).trim();
    setBusy(true);
    setError(null);
    try {
      if (!me?.accountId) await auth.createAccount(business);
      const tenant = await auth.createTenant(business, String(form.get('fromEmail') || '') || undefined);
      await client.invalidateQueries();
      await navigate({ to: '/$tenant', params: { tenant: tenant.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Welcome
      title={me?.accountId ? 'Add a business' : 'Tell us about your business'}
      subtitle="Each business gets its own clients, look and sending. You can connect its booking app afterwards."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Business name" name="business" placeholder="Linden Studio" required />
        <Field label="Send from (optional)" name="fromEmail" type="email" placeholder="hello@lindenstudio.co.uk" />
        {error && <Notice tone="bad">{error}</Notice>}
        <Button type="submit" disabled={busy} className="mt-1 h-10">
          {busy ? 'Setting up…' : 'Continue'}
        </Button>
      </form>
    </Welcome>
  );
}
