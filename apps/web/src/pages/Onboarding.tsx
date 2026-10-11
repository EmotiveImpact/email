/**
 * Setting up a business that signs up on its own: its details, its clients, its past visits and a
 * plan. Each step after the first can be skipped and done later from the app; the checklist on
 * Home remembers what is left.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { auth, billingQuery, meQuery, tenantsQuery, useChoosePlan, type PlanId } from '../api.ts';
import { Importer } from '../components/importer.tsx';
import { Button, Notice, cx } from '../components/ui.tsx';
import { brandVars } from '../theme.ts';
import { Field } from './SignIn.tsx';

export type SetupStep = 'business' | 'clients' | 'visits' | 'plan';
export type SetupSearch = { business?: string; step?: SetupStep };

const STEPS: { id: SetupStep; title: string; hint: string }[] = [
  { id: 'business', title: 'Your business', hint: 'Name, booking link and address' },
  { id: 'clients', title: 'Your clients', hint: 'From a spreadsheet or your booking system' },
  { id: 'visits', title: 'Your visits', hint: 'So we know who is due back' },
  { id: 'plan', title: 'Your plan', hint: 'Start free, change any time' },
];

type Source = 'saleane' | 'caleane' | 'other' | 'none';

/** "lindenstudio.co.uk/book" is what people type; the API wants a full address. */
export function fullUrl(value: string) {
  const v = value.trim();
  if (!v) return undefined;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

export function Onboarding() {
  const { business, step = 'business' } = useSearch({ from: '/setup' });
  const navigate = useNavigate();
  const { data: me } = useQuery(meQuery);
  const { data: tenants } = useQuery({ ...tenantsQuery, enabled: Boolean(me?.accountId) });
  const tenant = tenants?.find((t) => t.id === business);
  const [source, setSource] = useState<Source>('other');
  const go = (next: SetupStep, id = business) => navigate({ to: '/setup', search: { business: id, step: next } });
  const finish = () => navigate({ to: '/$tenant', params: { tenant: business! } });
  const index = STEPS.findIndex((s) => s.id === step);
  const current = business ? step : 'business';

  return (
    <div style={brandVars() as CSSProperties} className="min-h-full bg-canvas">
      <div className="mx-auto grid max-w-[1040px] gap-8 px-5 py-10 md:grid-cols-[260px_minmax(0,1fr)] md:py-16">
        <aside className="flex flex-col gap-8">
          <div className="display flex size-10 items-center justify-center rounded-xl bg-accent text-xl text-on-accent">N</div>
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {STEPS.map((s, i) => {
              const done = Boolean(business) && i < index;
              const active = s.id === current;
              return (
                <li key={s.id} className={cx('flex items-start gap-3 rounded-[12px] px-3 py-2.5', active && 'bg-paper shadow-ring')}>
                  <span
                    className={cx(
                      'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
                      done ? 'bg-accent text-on-accent' : active ? 'bg-ink text-white' : 'bg-well text-muted',
                    )}
                  >
                    {done ? <Check size={13} /> : i + 1}
                  </span>
                  <span className="flex flex-col">
                    <span className={cx('text-[14px]', active ? 'font-semibold' : done ? 'text-ink' : 'text-muted')}>{s.title}</span>
                    <span className="text-xs text-faint">{s.hint}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </aside>

        <main className="rounded-[22px] bg-paper px-6 py-7 shadow-card md:px-9 md:py-9">
          {current === 'business' && <BusinessStep hasAccount={Boolean(me?.accountId)} source={source} onSource={setSource} onDone={(id) => go('clients', id)} />}
          {current === 'clients' && business && (
            <Step
              title="Bring in your clients"
              subtitle="Everyone you have seen, with their email. We never email anyone who has not said yes to your news."
              next={() => go('visits')}
              back={() => go('business')}
            >
              {source === 'saleane' || source === 'caleane' ? (
                <Notice>Your clients arrive from {source === 'saleane' ? 'Saleane' : 'Caleane'} once its email setting is on. You can also add a spreadsheet here.</Notice>
              ) : null}
              <Importer tenant={business} kind="clients" />
            </Step>
          )}
          {current === 'visits' && business && (
            <Step
              title="Bring in past visits"
              subtitle="Dates of past appointments tell us each client's rhythm: who comes every four weeks, who is overdue, who has drifted away."
              next={() => go('plan')}
              back={() => go('clients')}
            >
              <Importer tenant={business} kind="visits" />
            </Step>
          )}
          {current === 'plan' && business && <PlanStep tenant={business} name={tenant?.name ?? 'your business'} onDone={finish} back={() => go('visits')} />}
        </main>
      </div>
    </div>
  );
}

function Step({ title, subtitle, children, next, back, nextLabel = 'Continue' }: { title: string; subtitle: string; children: ReactNode; next: () => void; back?: () => void; nextLabel?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="display m-0 text-[30px] leading-tight">{title}</h1>
        <p className="m-0 max-w-[560px] text-sm leading-relaxed text-muted">{subtitle}</p>
      </header>
      {children}
      <footer className="flex items-center justify-between gap-3 border-t border-rule pt-5">
        {back ? (
          <button type="button" onClick={back} className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[13px] text-muted underline">
            Back
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-3">
          <button type="button" onClick={next} className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[13px] text-muted underline">
            Skip for now
          </button>
          <Button onClick={next}>{nextLabel}</Button>
        </div>
      </footer>
    </div>
  );
}

function BusinessStep({ hasAccount, source, onSource, onDone }: { hasAccount: boolean; source: Source; onSource: (s: Source) => void; onDone: (tenantId: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get('business')).trim();
    const text = (k: string) => String(form.get(k) ?? '').trim() || undefined;
    setBusy(true);
    setError(null);
    try {
      if (!hasAccount) await auth.createAccount(name);
      const tenant = await auth.createTenant({
        name,
        fromEmail: text('fromEmail'),
        bookingUrl: fullUrl(String(form.get('bookingUrl') ?? '')),
        address: text('address'),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      await client.invalidateQueries();
      onDone(tenant.id);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^brand\.bookingUrl: .*/, 'That booking link does not look like a web address.') : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="display m-0 text-[30px] leading-tight">{hasAccount ? 'Add a business' : 'Tell us about your business'}</h1>
        <p className="m-0 max-w-[560px] text-sm leading-relaxed text-muted">Your emails go out in its name, with your booking link on every button and your address at the foot, as the law asks.</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Business name" name="business" placeholder="Linden Studio" required autoFocus />
        <Field label="Booking page" name="bookingUrl" placeholder="lindenstudio.co.uk/book" inputMode="url" />
        <div className="sm:col-span-2">
          <Field label="Postal address" name="address" placeholder="4 Linden Row, Leeds LS1 4AB" autoComplete="street-address" />
        </div>
        <Field label="Send from (optional)" name="fromEmail" type="email" placeholder="hello@lindenstudio.co.uk" />
        <label className="flex flex-col gap-1.5 text-[13px] font-medium">
          Where do you take bookings?
          <select
            value={source}
            onChange={(e) => onSource(e.target.value as Source)}
            className="h-10 rounded-[10px] border border-rule-strong bg-paper px-3 font-[inherit] text-sm font-normal text-ink outline-none focus:border-ink"
          >
            <option value="other">Another booking system</option>
            <option value="saleane">Saleane</option>
            <option value="caleane">Caleane</option>
            <option value="none">Phone, messages or a paper diary</option>
          </select>
        </label>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      <footer className="flex justify-end border-t border-rule pt-5">
        <Button type="submit" disabled={busy}>
          {busy ? 'Setting up…' : 'Continue'}
        </Button>
      </footer>
    </form>
  );
}

function PlanStep({ tenant, name, onDone, back }: { tenant: string; name: string; onDone: () => void; back: () => void }) {
  const { data } = useQuery(billingQuery(tenant));
  const [picked, setPicked] = useState<PlanId>('free');
  const choose = useChoosePlan(tenant);
  const people = data?.usage.contacts ?? 0;
  const fits = data?.plans.find((p) => p.contacts >= people)?.id ?? 'scale';
  // The free plan is greyed out once the list outgrows it, so start on the plan that fits.
  const choice = (data?.plans.find((p) => p.id === picked)?.contacts ?? Infinity) < people ? fits : picked;
  const choiceName = data?.plans.find((p) => p.id === choice)?.name ?? '';

  async function finish() {
    if (choice !== 'free' && choice !== data?.plan) {
      const { url } = await choose.mutateAsync(choice);
      if (url) return; // off to Stripe; it brings them back to Billing
    }
    onDone();
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="display m-0 text-[30px] leading-tight">Choose a plan</h1>
        <p className="m-0 max-w-[560px] text-sm leading-relaxed text-muted">
          {people > 0
            ? `${name} has ${people.toLocaleString('en-GB')} ${people === 1 ? 'person' : 'people'} who can get your news so far. Plans grow with that number; booking emails are always free.`
            : 'Plans are priced by the people who said yes to your news. Booking emails are always free.'}
        </p>
      </header>
      <div className="flex flex-col gap-2">
        {(data?.plans ?? []).map((plan) => {
          const tooSmall = plan.contacts < people;
          return (
            <label
              key={plan.id}
              className={cx(
                'flex cursor-pointer items-center gap-4 rounded-[14px] px-4 py-3.5 shadow-ring transition',
                choice === plan.id && 'bg-tint outline-2 outline-accent',
                tooSmall && 'cursor-not-allowed opacity-50',
              )}
            >
              <input type="radio" name="plan" disabled={tooSmall} checked={choice === plan.id} onChange={() => setPicked(plan.id)} className="accent-[var(--accent)]" />
              <span className="flex grow flex-col">
                <span className="text-[14px] font-semibold">
                  {plan.name}
                  {plan.id === fits && people > 0 && <span className="ml-2 rounded-full bg-paper px-2 py-0.5 text-[11px] font-medium text-accent-ink">Fits your list</span>}
                </span>
                <span className="text-xs text-muted">
                  {plan.contacts.toLocaleString('en-GB')} people · {plan.emails.toLocaleString('en-GB')} emails a month
                </span>
              </span>
              <span className="display text-[22px]">{plan.price ? `£${plan.price / 100}` : 'Free'}</span>
            </label>
          );
        })}
      </div>
      {data?.payments === 'sample' && <Notice>Payments are in test mode, so nobody is charged.</Notice>}
      {choose.isError && <Notice tone="bad">{choose.error.message}</Notice>}
      <footer className="flex items-center justify-between gap-3 border-t border-rule pt-5">
        <button type="button" onClick={back} className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[13px] text-muted underline">
          Back
        </button>
        <Button variant="accent" disabled={choose.isPending} onClick={finish}>
          {choose.isPending ? 'One moment…' : choice !== 'free' && data?.payments === 'live' ? 'Continue to payment' : `Start on ${choiceName}`}
        </Button>
      </footer>
    </div>
  );
}
