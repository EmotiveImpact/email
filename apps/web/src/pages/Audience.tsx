import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowRight, FileUp, Plus, Search, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { contactQuery, contactsQuery, segmentsQuery, useAddContact, type Consent, type Contact, type Rhythm } from '../api.ts';
import { money } from '../components/email-editor.tsx';
import { Importer, type ImportKind } from '../components/importer.tsx';
import { useTenant } from '../components/Shell.tsx';
import { Button, Card, Notice, PageTitle, Segmented, StatusBadge, cx } from '../components/ui.tsx';
import { describeSegment, eventLabel } from '../segments.ts';
import { Field } from './SignIn.tsx';

export type AudienceSearch = { view?: 'people' | 'segments'; q?: string; consent?: Consent; segment?: string; page?: number; contact?: string; import?: ImportKind };

const PAGE = 50;
const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fullName = (c: Pick<Contact, 'firstName' | 'lastName' | 'email'>) => [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email;

const TINTS = [
  ['#F3D9CC', '#6E2512'],
  ['#DCE7F3', '#1F3F6E'],
  ['#E3EEDF', '#2D5A22'],
  ['#EFE3F3', '#4F2466'],
  ['#F5ECD3', '#5C4510'],
];

/** Initials on a soft colour that stays the same for a person. */
function Avatar({ contact: c, size = 30 }: { contact: Pick<Contact, 'firstName' | 'lastName' | 'email'>; size?: number }) {
  const initials = ((c.firstName?.[0] ?? c.email[0] ?? '') + (c.lastName?.[0] ?? '')).toUpperCase();
  const [bg, fg] = TINTS[[...c.email].reduce((a, ch) => a + ch.charCodeAt(0), 0) % TINTS.length]!;
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-full font-semibold" style={{ width: size, height: size, background: bg, color: fg, fontSize: size * 0.36 }}>
      {initials}
    </span>
  );
}

const DAY = 86_400_000;

function rhythmText(r: Rhythm | null | undefined) {
  if (!r || !r.visits) return '–';
  if (!r.gapDays) return r.visits === 1 ? 'One visit so far' : '–';
  const weeks = Math.round(r.gapDays / 7);
  return `Every ${r.gapDays < 14 ? `${r.gapDays} days` : `${weeks} weeks`}`;
}

/** Booked, due soon, overdue or drifted away, in a few words. */
function NextVisit({ rhythm: r }: { rhythm: Rhythm | null | undefined }) {
  if (!r || (!r.visits && !r.nextVisit)) return <span className="font-normal text-faint">–</span>;
  if (r.nextVisit) {
    return <span className="text-good">Booked {new Date(r.nextVisit).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })}</span>;
  }
  if (!r.dueAt) return <span className="text-[#1F3F6E]">New client</span>;
  const days = Math.round((new Date(r.dueAt).getTime() - Date.now()) / DAY);
  if (days < -60) return <span className="text-bad">Away {Math.round(-days / 30)} months</span>;
  if (days < 0) return <span className="text-accent-ink">Due {-days === 1 ? 'yesterday' : `${-days} days ago`}</span>;
  if (days < 7) return <span>Due {new Date(r.dueAt).toLocaleDateString('en-GB', { weekday: 'long' })}</span>;
  return <span className="font-normal text-muted">Due in {days} days</span>;
}

export function Audience() {
  const tenant = useTenant();
  const search = useSearch({ from: '/$tenant/audience' });
  const navigate = useNavigate({ from: '/$tenant/audience' });
  const view = search.view ?? 'people';
  const set = (patch: Partial<AudienceSearch>) => navigate({ search: (s) => ({ ...s, ...patch }), replace: true });

  return (
    <>
      <PageTitle
        eyebrow="Audience"
        title="Your clients"
        subtitle="Everyone who has booked or signed up, what they did, and whether they want news."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => set({ import: 'clients' })}>
              <FileUp size={15} /> Import
            </Button>
            <Segmented
              label="View"
              value={view}
              onChange={(v) => set({ view: v === 'people' ? undefined : v, page: undefined })}
              options={[
                { value: 'people', label: 'People' },
                { value: 'segments', label: 'Segments' },
              ]}
            />
          </div>
        }
      />
      {view === 'people' ? <People search={search} set={set} /> : <Segments />}
      {search.import && <ImportPanel tenant={tenant.id} kind={search.import} onKind={(k) => set({ import: k })} onClose={() => set({ import: undefined })} />}
      {search.contact && <ContactPanel tenant={tenant.id} contact={search.contact} onClose={() => set({ contact: undefined })} />}
    </>
  );
}

function People({ search, set }: { search: AudienceSearch; set: (patch: Partial<AudienceSearch>) => void }) {
  const tenant = useTenant();
  const [text, setText] = useState(search.q ?? '');
  const [adding, setAdding] = useState(false);
  const page = search.page ?? 0;
  const { data: segments } = useQuery(segmentsQuery(tenant.id));
  const { data, isPending, isError, error } = useQuery({
    ...contactsQuery(tenant.id, { search: search.q, consent: search.consent, segment: search.segment, offset: page * PAGE }),
    placeholderData: keepPreviousData,
  });

  // Search as you type, a beat after the last key.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((search.q ?? '') !== text) set({ q: text || undefined, page: undefined });
    }, 250);
    return () => clearTimeout(t);
  }, [text, search.q, set]);

  const segment = segments?.find((s) => s.id === search.segment);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <label className="relative flex min-w-[260px] flex-1 items-center">
          <Search size={15} className="pointer-events-none absolute left-3 text-faint" />
          <span className="sr-only">Search</span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search by name or email"
            className="h-9 w-full rounded-full border border-rule-strong bg-paper pr-3 pl-9 font-[inherit] text-[13px] outline-none focus:border-ink"
          />
        </label>
        <Select
          label="News"
          value={search.consent ?? ''}
          onChange={(v) => set({ consent: (v || undefined) as Consent | undefined, page: undefined })}
          options={[
            ['', 'Any consent'],
            ['granted', 'Happy to hear news'],
            ['withdrawn', 'Said no to news'],
            ['unknown', 'Never asked'],
          ]}
        />
        <Select
          label="Segment"
          value={search.segment ?? ''}
          onChange={(v) => set({ segment: v || undefined, page: undefined })}
          options={[['', 'Everyone'], ...(segments ?? []).map((s) => [s.id, s.name] as [string, string])]}
        />
        <Button onClick={() => setAdding(true)}>
          <Plus size={15} /> Add person
        </Button>
      </div>
      {segment && <p className="m-0 -mt-2 text-[13px] text-muted">{describeSegment(segment.definition)}.</p>}
      {adding && <AddPerson onDone={() => setAdding(false)} />}
      {isError && <Notice tone="bad">{error.message}</Notice>}

      <Card className="overflow-hidden">
        {isPending ? (
          <p className="m-0 px-5 py-8 text-center text-[13px] text-muted">Loading…</p>
        ) : data!.contacts.length === 0 ? (
          <p className="m-0 px-5 py-10 text-center text-[13px] text-muted">
            {search.q || search.consent || search.segment ? 'Nobody matches.' : 'No one here yet. People appear as your booking app sends them, or add them yourself.'}
          </p>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th className="eyebrow px-5 py-3 font-medium">Client</th>
                <th className="eyebrow hidden px-3 py-3 font-medium md:table-cell">Rhythm</th>
                <th className="eyebrow px-3 py-3 font-medium">Next</th>
                <th className="eyebrow px-3 py-3 font-medium">News</th>
                <th className="eyebrow hidden px-5 py-3 text-right font-medium lg:table-cell">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {data!.contacts.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => set({ contact: c.id })}
                  className={cx('cursor-pointer border-t border-rule hover:bg-soft/60', search.contact === c.id && 'bg-tint')}
                >
                  <td className="max-w-[320px] px-5 py-2.5">
                    <div className="flex items-center gap-3">
                      <Avatar contact={c} />
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{fullName(c)}</div>
                        <div className="truncate text-xs text-muted">{c.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-3 py-2.5 text-[13px] text-[#55555C] md:table-cell">{rhythmText(c.rhythm)}</td>
                  <td className="px-3 py-2.5 text-[13px] font-medium">
                    <NextVisit rhythm={c.rhythm} />
                  </td>
                  <td className="px-3 py-2.5">
                    <ConsentBadge consent={c.marketingConsent} />
                  </td>
                  <td className="hidden px-5 py-2.5 text-right text-muted tabular-nums lg:table-cell">{date(c.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {data && data.total > PAGE && (
        <div className="flex items-center justify-between text-[13px] text-muted">
          <span>
            {page * PAGE + 1} to {Math.min((page + 1) * PAGE, data.total)} of {data.total.toLocaleString('en-GB')}
          </span>
          <span className="flex gap-2">
            <Button variant="secondary" disabled={page === 0} onClick={() => set({ page: page - 1 || undefined })}>
              Previous
            </Button>
            <Button variant="secondary" disabled={(page + 1) * PAGE >= data.total} onClick={() => set({ page: page + 1 })}>
              Next
            </Button>
          </span>
        </div>
      )}
      {data && data.total <= PAGE && data.total > 0 && <p className="m-0 text-[13px] text-muted">{data.total.toLocaleString('en-GB')} people</p>}
    </>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          'h-9 cursor-pointer appearance-none rounded-full border bg-paper pr-8 pl-3.5 font-[inherit] text-[13px] outline-none',
          value ? 'border-ink font-medium' : 'border-rule-strong',
        )}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <span aria-hidden className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[10px] text-faint">
        ▼
      </span>
    </label>
  );
}

export function ConsentBadge({ consent }: { consent: Consent }) {
  const map = { granted: ['Yes', 'bg-good-bg text-good'], withdrawn: ['No', 'bg-bad-bg text-bad'], unknown: ['Not asked', 'bg-soft text-muted'] } as const;
  const [label, tone] = map[consent];
  return <span className={cx('inline-flex rounded-full px-2.5 py-[3px] text-xs font-medium whitespace-nowrap', tone)}>{label}</span>;
}

function Attributes({ attributes, limit }: { attributes: Record<string, unknown>; limit?: number }) {
  const entries = Object.entries(attributes).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object');
  if (entries.length === 0) return <span className="text-faint">—</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {entries.slice(0, limit).map(([k, v]) => (
        <span key={k} className="rounded-md bg-soft px-1.5 py-0.5 text-xs whitespace-nowrap text-muted">
          <span className="text-faint">{k}</span> {String(v)}
        </span>
      ))}
    </span>
  );
}

function AddPerson({ onDone }: { onDone: () => void }) {
  const tenant = useTenant();
  const add = useAddContact(tenant.id);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await add.mutateAsync({
      email: String(form.get('email')),
      firstName: String(form.get('firstName') || '') || undefined,
      lastName: String(form.get('lastName') || '') || undefined,
      consent: form.get('consent') === 'on',
    });
    onDone();
  }
  return (
    <Card className="px-5 py-5">
      <form onSubmit={submit} className="grid items-end gap-3 md:grid-cols-[1fr_1fr_1.4fr_auto]">
        <Field label="First name" name="firstName" autoFocus />
        <Field label="Last name" name="lastName" />
        <Field label="Email" name="email" type="email" required />
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={add.isPending}>
            Add
          </Button>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-muted md:col-span-4">
          <input type="checkbox" name="consent" className="size-4 accent-(--accent)" />
          They have said yes to news and offers (we record that you added it, and when)
        </label>
        {add.isError && (
          <div className="md:col-span-4">
            <Notice tone="bad">{add.error.message}</Notice>
          </div>
        )}
      </form>
    </Card>
  );
}

function Segments() {
  const tenant = useTenant();
  const { data, isPending } = useQuery(segmentsQuery(tenant.id));
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {isPending && <p className="text-[13px] text-muted">Loading…</p>}
      {data?.map((s) => (
        <Link
          key={s.id}
          to="/$tenant/audience/segments/$segment"
          params={{ tenant: tenant.id, segment: s.id }}
          className="group flex flex-col gap-2 rounded-2xl border border-rule bg-paper px-5 py-4 transition hover:border-rule-strong"
        >
          <span className="flex items-baseline justify-between gap-3">
            <span className="text-[15px] font-semibold">{s.name}</span>
            <span className="display text-2xl">{(s.size ?? 0).toLocaleString('en-GB')}</span>
          </span>
          <span className="text-[13px] leading-snug text-muted">{describeSegment(s.definition)}</span>
          <span className="mt-1 flex items-center gap-1.5 text-[13px] font-semibold text-accent-ink">
            Open <ArrowRight size={14} />
          </span>
        </Link>
      ))}
      <Link
        to="/$tenant/audience/segments/$segment"
        params={{ tenant: tenant.id, segment: 'new' }}
        className="flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-rule-strong text-[13px] font-semibold text-muted hover:text-ink"
      >
        <Plus size={18} /> New segment
      </Link>
    </div>
  );
}

function ContactPanel({ tenant, contact, onClose }: { tenant: string; contact: string; onClose: () => void }) {
  const { data, isPending, isError } = useQuery(contactQuery(tenant, contact));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/10" onClick={onClose}>
      <aside
        aria-label="Person"
        onClick={(e) => e.stopPropagation()}
        className="m-3 flex w-full max-w-[440px] flex-col overflow-hidden rounded-[18px] border border-rule bg-paper shadow-[0_12px_40px_#00000026]"
      >
        <div className="flex h-[58px] shrink-0 items-center justify-between border-b border-rule pr-3 pl-5">
          <span className="text-sm font-semibold">{data ? fullName(data.contact) : 'Person'}</span>
          <button type="button" onClick={onClose} aria-label="Close" className="flex size-8 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted hover:bg-soft">
            <X size={17} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {isPending && <p className="text-[13px] text-muted">Loading…</p>}
          {isError && <Notice tone="bad">Could not load this person.</Notice>}
          {data && (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <div className="text-sm">{data.contact.email}</div>
                <div className="flex items-center gap-2 text-[13px] text-muted">
                  News: <ConsentBadge consent={data.contact.marketingConsent} />
                </div>
                <Attributes attributes={data.contact.attributes} />
                {data.suppressions.length > 0 && (
                  <Notice tone="bad">
                    {data.suppressions.map((s) => (
                      <div key={s.reason + s.scope}>
                        {s.reason === 'hard_bounce'
                          ? 'This address bounced, so nothing is sent to it.'
                          : s.reason === 'complaint'
                            ? 'They marked an email as spam, so they only get reminders and receipts.'
                            : s.reason === 'unsubscribe'
                              ? 'They unsubscribed from news. Reminders and receipts still go.'
                              : 'Blocked by the business.'}
                      </div>
                    ))}
                  </Notice>
                )}
              </div>
              {data.rhythm && data.rhythm.visits > 0 && <RhythmCard rhythm={data.rhythm} />}
              {data.appointments.length > 0 && (
                <Section title="Visits" empty="">
                  {data.appointments.map((a) => (
                    <li key={a.id} className="flex justify-between gap-3 border-t border-rule py-2 first:border-t-0">
                      <span className={cx(a.status === 'cancelled' || a.status === 'no_show' ? 'text-muted line-through' : '')}>
                        {a.service ?? 'Appointment'}
                        {a.staff && <span className="text-muted"> · {a.staff}</span>}
                      </span>
                      <span className="text-muted tabular-nums">
                        {a.price !== null && <>{money(a.price)} · </>}
                        {date(a.startsAt)}
                      </span>
                    </li>
                  ))}
                </Section>
              )}
              <Section title="Timeline" empty="Nothing has happened yet.">
                {data.events.map((e) => (
                  <li key={e.id} className="flex justify-between gap-3 border-t border-rule py-2 first:border-t-0">
                    <span className="first-letter:uppercase">
                      {eventLabel(e.name)}
                      {typeof e.properties.treatment === 'string' && <span className="text-muted"> · {e.properties.treatment}</span>}
                    </span>
                    <span className="text-muted tabular-nums">{date(e.occurredAt)}</span>
                  </li>
                ))}
              </Section>
              <Section title="Emails" empty="No emails yet.">
                {data.messages.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 border-t border-rule py-2 first:border-t-0">
                    <span className="min-w-0 truncate">{m.subject}</span>
                    <StatusBadge status={m.status} />
                  </li>
                ))}
              </Section>
              <Section title="Consent history" empty="No consent recorded.">
                {data.consents.map((c) => (
                  <li key={c.id} className="flex justify-between gap-3 border-t border-rule py-2 first:border-t-0">
                    <span>
                      {c.status === 'granted' ? 'Said yes to news' : 'Said no to news'}
                      <span className="block text-xs text-muted">{c.source}</span>
                    </span>
                    <span className="text-muted tabular-nums">{date(c.recordedAt)}</span>
                  </li>
                ))}
              </Section>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/** Their rhythm: how often they come, when they last did, and when they are due. */
function RhythmCard({ rhythm: r }: { rhythm: Rhythm }) {
  const now = Date.now();
  const due = r.dueAt ? new Date(r.dueAt).getTime() : null;
  const next = r.bookedAhead && r.nextVisit
    ? { label: 'Booked', value: date(r.nextVisit), tone: 'good' as const }
    : due === null
      ? { label: 'Due', value: 'After a second visit', tone: 'muted' as const }
      : due < now
        ? { label: 'Overdue since', value: date(r.dueAt!), tone: 'warn' as const }
        : { label: 'Due around', value: date(r.dueAt!), tone: 'muted' as const };
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-soft px-4 py-3.5 text-[13px]">
      <Fact label="Visits" value={String(r.visits)} />
      <Fact label="Usually every" value={r.gapDays ? weeksText(r.gapDays) : '–'} />
      <Fact label="Last visit" value={r.lastVisit ? `${date(r.lastVisit)}${r.lastService ? ` · ${r.lastService}` : ''}` : '–'} />
      <Fact label={next.label} value={next.value} tone={next.tone} />
    </div>
  );
}

const weeksText = (days: number) => (days < 14 ? `${days} days` : `${Math.round(days / 7)} weeks`);

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' | 'muted' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted">{label}</span>
      <span className={cx('truncate font-medium', tone === 'good' && 'text-good', tone === 'warn' && 'text-warn')}>{value}</span>
    </div>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section>
      <h3 className="display m-0 mb-1.5 text-[15px]">{title}</h3>
      {children.length === 0 ? <p className="m-0 text-[13px] text-muted">{empty}</p> : <ul className="m-0 list-none p-0 text-[13px]">{children}</ul>}
    </section>
  );
}

/** Import from a spreadsheet: clients, or past visits for each client's rhythm. */
function ImportPanel({ tenant, kind, onKind, onClose }: { tenant: string; kind: ImportKind; onKind: (k: ImportKind) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <div role="dialog" aria-label="Import" className="flex h-full w-full max-w-[600px] flex-col gap-5 overflow-y-auto bg-paper px-6 py-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="display m-0 text-[22px]">Import from a spreadsheet</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="grid size-8 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-muted hover:bg-soft">
            <X size={16} />
          </button>
        </div>
        <Segmented
          label="What"
          value={kind}
          onChange={onKind}
          options={[
            { value: 'clients', label: 'Clients' },
            { value: 'visits', label: 'Past visits' },
          ]}
        />
        <Importer key={kind} tenant={tenant} kind={kind} />
      </div>
    </div>
  );
}
