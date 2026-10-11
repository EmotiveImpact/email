import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarCheck, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  connectSquare,
  diaryConnectionQuery,
  useConnectPhorest,
  useDisconnectDiary,
  useFinishSquare,
  useSyncDiary,
  type DiaryConnection,
  type DiaryProvider,
  type PhorestLogin,
} from '../api.ts';
import { useTenant } from '../components/Shell.tsx';
import { Button, Card, CardTitle, Notice, PageTitle, cx } from '../components/ui.tsx';

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Codes already sent back to the API, so a second render (or React's double effect) never reuses one. */
const finished = new Set<string>();

/** Connects the business's own booking system, so flows read real bookings and free times (D132, D138). */
export function BookingSystem() {
  const tenant = useTenant();
  const { data } = useSuspenseQuery(diaryConnectionQuery(tenant.id));
  const finish = useFinishSquare(tenant.id);
  const [refused] = useState(() => new URLSearchParams(window.location.search).has('refused'));

  // Square sends the owner back with a one-time code; finish it here, where they are signed in.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (code || params.has('refused')) window.history.replaceState(null, '', window.location.pathname);
    if (!code || !state || finished.has(code)) return;
    finished.add(code);
    finish.mutate({ code, state });
  }, [finish]);

  return (
    <>
      <PageTitle title="Booking system" subtitle="Connect your diary so flows know who is due back and which times are still free." />
      {refused && <Notice>Square was not connected. You can try again whenever you like.</Notice>}
      {finish.isPending && <Notice>Connecting Square…</Notice>}
      {finish.isError && <Notice tone="bad">{finish.error.message}</Notice>}
      <div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        {data.connection ? <Connected data={data} /> : <Choose data={data} />}
        <Card className="flex flex-col gap-3 px-5 py-5">
          <CardTitle>What we read</CardTitle>
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-4 text-[13px] leading-relaxed">
            <li>Your bookings from the last six months and the next month, with each client’s name and email.</li>
            <li>Your services and prices, so emails name the treatment.</li>
            <li>Your free times for the next two weeks, so emails can offer them.</li>
          </ul>
          <p className="m-0 text-xs leading-relaxed text-muted">
            Access is read only. We never book, move or cancel anything in your diary, and you can disconnect at any time. Bookings without an email address
            are left out.
          </p>
        </Card>
      </div>
    </>
  );
}

const control =
  'h-9 w-full rounded-[10px] border border-rule-strong bg-paper px-2.5 font-[inherit] text-[13px] text-ink outline-none focus:border-ink';
const NAMES: Record<DiaryProvider, string> = { square: 'Square Appointments', phorest: 'Phorest' };

function Choose({ data }: { data: DiaryConnection }) {
  const tenant = useTenant();
  const [picked, setPicked] = useState<DiaryProvider | null>(null);

  return (
    <Card className="flex flex-col gap-4 px-5 py-5">
      <CardTitle aside="Not connected">Connect your diary</CardTitle>
      {(['square', 'phorest'] as const).map((provider) => (
        <div key={provider} className="flex flex-col gap-4 rounded-[12px] border border-rule px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <CalendarCheck size={20} className="shrink-0 text-accent-ink" aria-hidden />
              <div className="flex flex-col">
                <span className="text-[14px] font-semibold">{NAMES[provider]}</span>
                <span className="text-xs text-muted">
                  {provider === 'square'
                    ? data.available.square
                      ? 'Sign in to Square and allow read access.'
                      : 'Coming soon on this platform.'
                    : 'Paste the API login Phorest gives you.'}
                </span>
              </div>
            </div>
            {picked !== provider && (
              <Button variant="secondary" onClick={() => setPicked(provider)} disabled={!data.available[provider]}>
                Set up
              </Button>
            )}
          </div>
          {picked === provider && (provider === 'square' ? <SquareSetup /> : <PhorestSetup />)}
        </div>
      ))}
      <p className="m-0 text-[13px] leading-relaxed text-muted">
        Using Fresha, Timely or another system? Export your clients and visits and{' '}
        <Link to="/$tenant/audience" params={{ tenant: tenant.id }} search={{ import: 'visits' }} className="font-semibold text-ink underline">
          bring them in
        </Link>
        , or send them from your own app through{' '}
        <Link to="/$tenant/developers" params={{ tenant: tenant.id }} className="font-semibold text-ink underline">
          the API
        </Link>
        .
      </p>
    </Card>
  );
}

function SquareSetup() {
  const tenant = useTenant();
  const [consent, setConsent] = useState<'granted' | 'unknown' | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!consent) return;
    setOpening(true);
    setError(null);
    try {
      await connectSquare(tenant.id, consent);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOpening(false);
    }
  }

  return (
    <>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 text-[13px] font-medium">Did your Square clients agree to hear news and offers from you?</legend>
        {(
          [
            ['granted', 'Yes, they agreed', 'For example, they ticked a box when booking. We record that you confirmed it. Anyone who unsubscribed in Square is left out.'],
            ['unknown', 'Not sure', 'They still get booking emails. Ask them to join your list before sending them news.'],
          ] as const
        ).map(([v, title, hint]) => (
          <label key={v} className={cx('flex cursor-pointer items-start gap-3 rounded-[12px] px-3.5 py-3 shadow-ring', consent === v && 'bg-tint')}>
            <input type="radio" name="consent" checked={consent === v} onChange={() => setConsent(v)} className="mt-1 accent-[var(--accent)]" />
            <span className="flex flex-col gap-0.5">
              <span className="text-[13.5px] font-medium">{title}</span>
              <span className="text-xs leading-relaxed text-muted">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error && <Notice tone="bad">{error}</Notice>}
      <div>
        <Button onClick={start} disabled={!consent || opening}>
          {opening ? 'Opening Square…' : 'Connect Square'}
        </Button>
      </div>
    </>
  );
}

function PhorestSetup() {
  const tenant = useTenant();
  const connect = useConnectPhorest(tenant.id);
  const [login, setLogin] = useState<PhorestLogin>({ username: '', password: '', businessId: '', region: 'eu' });
  const [branches, setBranches] = useState<{ id: string; name: string }[] | null>(null);
  const set = (patch: Partial<PhorestLogin>) => setLogin((l) => ({ ...l, ...patch }));
  const ready = login.username.trim() && login.password && login.businessId.trim() && (!branches || login.branchId);

  function submit(e: FormEvent) {
    e.preventDefault();
    connect.mutate(login, {
      onSuccess: (result) => {
        if ('branches' in result) {
          setBranches(result.branches);
          set({ branchId: undefined });
        }
      },
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <ol className="m-0 flex list-decimal flex-col gap-1 pl-4 text-[13px] leading-relaxed">
        <li>
          Email <span className="font-medium">api-requests@phorest.com</span> from the address on your Phorest account, with your Phorest account number, and
          ask for API access for your business.
        </li>
        <li>Phorest sends a username, a password and your business ID. Paste them below.</li>
      </ol>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          Username
          <input className={control} value={login.username} onChange={(e) => set({ username: e.target.value })} placeholder="global/you@yoursalon.co.uk" autoComplete="off" />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          Password
          <input className={control} type="password" value={login.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          Business ID
          <input className={control} value={login.businessId} onChange={(e) => set({ businessId: e.target.value })} autoComplete="off" />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          Where your account is
          <select className={control} value={login.region} onChange={(e) => set({ region: e.target.value as PhorestLogin['region'] })}>
            <option value="eu">UK and Ireland</option>
            <option value="us">US, Canada or Australia</option>
          </select>
        </label>
        {branches && (
          <label className="flex flex-col gap-1 text-[13px] font-medium sm:col-span-2">
            Which salon is this business?
            <select className={control} value={login.branchId ?? ''} onChange={(e) => set({ branchId: e.target.value || undefined })}>
              <option value="">Choose a branch</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="m-0 text-xs leading-relaxed text-muted">We follow each client’s email marketing choice in Phorest. The login is stored encrypted and used only to read your diary.</p>
      {connect.isError && <Notice tone="bad">{connect.error.message}</Notice>}
      <div>
        <Button type="submit" disabled={!ready || connect.isPending}>
          {connect.isPending ? 'Checking with Phorest…' : 'Connect Phorest'}
        </Button>
      </div>
    </form>
  );
}

function Connected({ data }: { data: DiaryConnection }) {
  const tenant = useTenant();
  const connection = data.connection!;
  const name = connection.provider === 'square' ? 'Square' : 'Phorest';
  const sync = useSyncDiary(tenant.id);
  const disconnect = useDisconnectDiary(tenant.id);
  const [confirming, setConfirming] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);

  return (
    <Card className="flex flex-col gap-4 px-5 py-5">
      <CardTitle aside={connection.status === 'error' ? 'Needs attention' : 'Connected'}>{NAMES[connection.provider]}</CardTitle>
      {connection.status === 'error' && <Notice tone="bad">{connection.error ?? `The last read from ${name} did not work.`}</Notice>}
      <dl className="m-0 grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted">Location</dt>
        <dd className="m-0 font-medium">{connection.locationName ?? 'None found'}</dd>
        <dt className="text-muted">Clients</dt>
        <dd className="m-0">
          {connection.provider === 'phorest'
            ? 'As each client chose in Phorest'
            : connection.consent === 'granted'
              ? 'Agreed to your news, as you confirmed'
              : 'Booking emails only until they join your list'}
        </dd>
        <dt className="text-muted">Connected</dt>
        <dd className="m-0">{when(connection.connectedAt)}</dd>
        <dt className="text-muted">Last read</dt>
        <dd className="m-0" aria-live="polite">
          {connection.lastSyncAt ? when(connection.lastSyncAt) : connection.status === 'active' ? 'Reading your diary now…' : 'Not yet'}
        </dd>
      </dl>
      <p className="m-0 text-xs leading-relaxed text-muted">
        {connection.provider === 'square' ? 'We read your diary every 15 minutes, and straight away when Square tells us a booking changed.' : 'We read your diary every 15 minutes.'}
      </p>
      {sync.isError && <Notice tone="bad">{sync.error.message}</Notice>}
      {disconnect.isError && <Notice tone="bad">{disconnect.error.message}</Notice>}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-rule px-4 py-3">
          <span className="grow text-[13px]">Disconnect {name}? Bookings already brought in stay; free times stop showing in emails.</span>
          <Button ref={cancel} variant="secondary" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
          <Button onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending}>
            <RefreshCw size={14} aria-hidden /> Read it now
          </Button>
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        </div>
      )}
    </Card>
  );
}
