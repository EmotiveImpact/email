import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, CalendarHeart, CalendarPlus, HeartHandshake, PenLine, RotateCcw, Sparkles } from 'lucide-react';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import {
  diaryQuery,
  flowQuery,
  flowsQuery,
  previewFlow,
  useResetFlow,
  useSaveFlow,
  type EmailDoc,
  type Flow,
  type FlowDetail,
  type FlowKind,
} from '../api.ts';
import { BlocksCard, Preview, TagField, control, fill, money } from '../components/email-editor.tsx';
import { useTenant } from '../components/Shell.tsx';
import { Button, Card, CardTitle, Notice, StatusBadge, Switch, cx } from '../components/ui.tsx';
import { inStudio } from '../studio.ts';
import { rate, when } from './Campaigns.tsx';

const nf = new Intl.NumberFormat('en-GB');

const ICONS: Record<FlowKind, ReactNode> = {
  welcome: <Sparkles size={15} />,
  rebook: <CalendarHeart size={15} />,
  fill_slots: <CalendarPlus size={15} />,
  winback: <HeartHandshake size={15} />,
};

/** What a send was for, in words: "after their visit on 4 Oct", "for Thursday's gaps". */
function reasonText(reason: string) {
  const [kind, date] = reason.split(':');
  const day = date ? new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: kind === 'fill' ? 'long' : undefined, day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
  if (kind === 'fill') return `Free times on ${day}`;
  if (kind === 'rebook') return `Due back after ${day}`;
  if (kind === 'winback') return `Last seen ${day}`;
  return 'After their first visit';
}

// ---------------------------------------------------------------- the list and one flow's path

const DAY = 86_400_000;
const TINTS = [
  ['#F3D9CC', '#6E2512'],
  ['#DCE7F3', '#1F3F6E'],
  ['#E3EEDF', '#2D5A22'],
  ['#EFE3F3', '#4F2466'],
  ['#F5ECD3', '#5C4510'],
];

const nameOf = (p: { firstName: string | null; lastName: string | null; email: string }) => [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email;
const initialsOf = (p: { firstName: string | null; lastName: string | null; email: string }) =>
  ((p.firstName?.[0] ?? p.email[0] ?? '') + (p.lastName?.[0] ?? '')).toUpperCase();
const longDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** "Due 2 days ago", "Due Thursday": when a client would usually be back. */
function dueText(iso: string | null, now = Date.now()) {
  if (!iso) return '';
  const days = Math.round((new Date(iso).getTime() - now) / DAY);
  if (days < -1) return `Due ${-days} days ago`;
  if (days === -1) return 'Due yesterday';
  if (days === 0) return 'Due today';
  if (days < 7) return `Due ${new Date(iso).toLocaleDateString('en-GB', { weekday: 'long' })}`;
  return `Due in ${days} days`;
}

function sinceText(iso: string | null, now = Date.now()) {
  if (!iso) return '';
  const days = Math.round((now - new Date(iso).getTime()) / DAY);
  return days < 14 ? `Visited ${days} ${days === 1 ? 'day' : 'days'} ago` : `Last in ${Math.round(days / 7)} weeks ago`;
}

/** What starts each flow, in a line, from its settings. */
function trigger(flow: Flow): { title: string; sub: string } {
  const s = flow.settings;
  switch (flow.kind) {
    case 'welcome':
      return { title: `${s.delayDays} ${s.delayDays === 1 ? 'day' : 'days'} after a first visit`, sub: 'Once per client, for new clients only' };
    case 'rebook':
      return { title: `${s.graceDays} days past their usual gap`, sub: `Worked out from each client’s visits; ${s.firstGapDays} days after a single visit` };
    case 'fill_slots':
      return {
        title: `A day with ${s.minOpenSlots} or more free slots`,
        sub: `Looking ${s.leadDays === 0 ? 'from today' : `${s.leadDays} ${s.leadDays === 1 ? 'day' : 'days'} ahead`} to ${s.horizonDays} days ahead`,
      };
    case 'winback':
      return { title: `${s.afterDays} days since their last visit`, sub: 'Longer for clients who usually leave long gaps' };
  }
}

function useSelected(id?: string) {
  const tenant = useTenant();
  const { data: flows } = useSuspenseQuery(flowsQuery(tenant.id));
  const chosen = flows.find((f) => f.id === id) ?? flows.find((f) => f.live) ?? flows[0]!;
  return { flows, chosen };
}

/** /flows: the list with the first live flow open. */
export function Flows() {
  const { flows, chosen } = useSelected();
  return <FlowsScreen flows={flows} selected={chosen.id} />;
}

/** /flows/$flow: the list with that flow open. */
export function FlowOverview() {
  const { flow: id } = useParams({ from: '/$tenant/flows/$flow' });
  const { flows } = useSelected(id);
  return <FlowsScreen flows={flows} selected={id} />;
}

function FlowsScreen({ flows, selected }: { flows: Flow[]; selected: string }) {
  const tenant = useTenant();
  const { data: diary } = useQuery(diaryQuery(tenant.id));
  const booked = flows.reduce((sum, f) => sum + f.stats.bookings, 0);
  const revenue = flows.reduce((sum, f) => sum + f.stats.revenue, 0);
  return (
    <div className="grid items-start gap-6 @4xl:grid-cols-[280px_minmax(0,1fr)]">
      <aside aria-label="Flows" className="flex flex-col gap-3 @4xl:sticky @4xl:top-4">
        <div className="flex flex-col gap-1.5 px-1 pt-2 pb-1.5">
          <h1 className="display m-0 text-[34px] leading-none">Flows</h1>
          <span className="text-[13px] leading-snug text-muted">
            {booked ? (
              <>
                <strong className="num text-ink">{money(revenue)}</strong> booked from {nf.format(flows.reduce((sum, f) => sum + f.stats.sent, 0))} flow emails in
                the last 90 days
              </>
            ) : (
              'Emails that send themselves, timed by your diary.'
            )}
          </span>
        </div>
        {flows.map((f) => (
          <FlowListCard key={f.id} flow={f} selected={f.id === selected} />
        ))}
        <p className="m-0 px-1 pt-1 text-xs leading-relaxed text-muted">
          Flows send between 9am and 7pm your time, only to clients who said yes to news, and never more than one marketing email in three days per client.
        </p>
      </aside>
      <div className="flex min-w-0 flex-col gap-4">
        {diary && !diary.connected && (
          <Notice>
            <strong>Your diary is not connected yet.</strong> Flows need your bookings and free times. Saleane and Caleane send them for you; other booking
            systems use <code className="font-mono text-xs">PUT /v1/appointments</code> and <code className="font-mono text-xs">/v1/availability</code>.
          </Notice>
        )}
        {!tenant.brand.bookingUrl && (
          <Notice>
            Add your booking link in{' '}
            {inStudio() ? (
              'your settings'
            ) : (
              <Link to="/$tenant/settings/appearance" params={{ tenant: tenant.id }} className="font-semibold underline">
                Appearance
              </Link>
            )}{' '}
            before switching a flow on; every flow email points clients to it.
          </Notice>
        )}
        <Suspense fallback={<Card className="h-[520px] animate-pulse" />}>
          <FlowPath id={selected} />
        </Suspense>
      </div>
    </div>
  );
}

function FlowListCard({ flow, selected }: { flow: Flow; selected: boolean }) {
  const tenant = useTenant();
  const s = flow.stats;
  return (
    <Link
      to="/$tenant/flows/$flow"
      params={{ tenant: tenant.id, flow: flow.id }}
      aria-current={selected ? 'page' : undefined}
      className={cx(
        'flex flex-col gap-2.5 rounded-[16px] bg-paper px-4 py-3.5 transition',
        selected ? 'shadow-[0_0_0_2px_var(--accent),0_8px_24px_-12px_color-mix(in_oklab,var(--accent)_45%,transparent)]' : 'shadow-card hover:shadow-lift',
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className={cx('grid size-7 shrink-0 place-items-center rounded-lg', flow.live ? 'bg-tint text-accent-ink' : 'bg-soft text-muted')}>{ICONS[flow.kind]}</span>
          <span className="truncate text-sm font-semibold">{flow.name}</span>
        </span>
        {flow.live ? (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-good">
            <span className="size-1.5 rounded-full bg-[#2E8B57]" />
            Live
          </span>
        ) : (
          <span className="text-[11.5px] text-faint">Off</span>
        )}
      </span>
      <span className="flex gap-4 text-xs text-muted">
        {flow.live || s.sent ? (
          <>
            <span>
              <strong className="num text-ink">{nf.format(s.bookings)}</strong> booked
            </span>
            <span>
              <strong className="num text-ink">{money(s.revenue)}</strong>
            </span>
            {flow.waiting > 0 && <span>{nf.format(flow.waiting)} due now</span>}
          </>
        ) : flow.waiting > 0 ? (
          `${nf.format(flow.waiting)} ${flow.waiting === 1 ? 'client' : 'clients'} would get it now`
        ) : (
          'Nobody due right now'
        )}
      </span>
    </Link>
  );
}

function FlowPath({ id }: { id: string }) {
  const tenant = useTenant();
  const { data: flow } = useSuspenseQuery(flowQuery(tenant.id, id));
  const toggle = useSaveFlow(tenant.id, flow.id);
  const s = flow.stats;
  const when = trigger(flow);
  const blocked = !flow.live && flow.problems.length > 0;
  return (
    <>
      <header className="flex flex-wrap items-center gap-3 pt-2">
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1">
          <span className="eyebrow">Flow</span>
          <h2 className="display m-0 text-[28px] leading-tight">{flow.name}</h2>
        </div>
        <Link
          to="/$tenant/flows/$flow/email"
          params={{ tenant: tenant.id, flow: flow.id }}
          className="inline-flex h-9 items-center gap-2 rounded-full bg-paper px-4 text-[13px] font-medium shadow-ring hover:bg-soft"
        >
          <PenLine size={14} /> Edit email and timing
        </Link>
        <label className="flex h-9 items-center gap-2.5 rounded-full bg-paper pr-1.5 pl-3.5 text-[13px] font-medium shadow-ring">
          {flow.live ? 'Live' : 'Off'}
          <Switch checked={flow.live} label="Send this flow" disabled={toggle.isPending || (blocked && !flow.live)} onChange={(live) => toggle.mutate({ live })} />
        </label>
      </header>
      <p className="m-0 -mt-1 max-w-[640px] text-[13.5px] leading-relaxed text-[#55555C]">{flow.description}</p>
      {toggle.isError && <Notice tone="bad">{toggle.error.message}</Notice>}
      {blocked && (
        <Notice>
          Before it can go on: {flow.problems[0]}
          {flow.problems.length > 1 && ` (and ${flow.problems.length - 1} more)`}
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Figure label="Booked" value={nf.format(s.bookings)} sub="within five days of an email" strong />
        <Figure label="Value" value={money(s.revenue)} sub="last 90 days" strong />
        <Figure label="Opened" value={rate(s.opened, s.sent)} sub={`${nf.format(s.opened)} people`} />
        <Figure label="Sent" value={nf.format(s.sent)} sub="in all" />
      </div>

      <section aria-label="How it works" className="dots grid gap-6 rounded-[18px] p-6 @3xl:grid-cols-[minmax(0,1fr)_300px]">
        <ol className="m-0 flex list-none flex-col items-center p-0">
          <Node tag="When" tone="accent" title={when.title} sub={when.sub} />
          <Wire />
          <Node
            tag="Who"
            tone="blue"
            title={flow.kind === 'fill_slots' ? `${flow.settings.perSlot} clients per free slot, closest to due` : 'Clients who said yes to news'}
            sub={`${nf.format(flow.waiting)} right now · none emailed in the last three days`}
          />
          <Wire />
          <Node
            tag="Email"
            tone="ink"
            title={fill(flow.subject, tenant.name, flow.next.fill ? new Date(`${flow.next.fill.day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }) : undefined)}
            sub={s.sent ? `${rate(s.opened, s.sent)} opened · ${rate(s.clicked, s.sent)} clicked` : 'Sent between 9am and 7pm your time'}
            to={{ flow: flow.id }}
          />
          <Wire />
          <Node tag="Result" tone="good" title={s.bookings ? `${nf.format(s.bookings)} booked · ${money(s.revenue)}` : 'Bookings show here'} sub="Counted when a client books within five days" />
        </ol>
        <NextSend flow={flow} />
      </section>

      <FlowResults flow={flow} />
    </>
  );
}

function Figure({ label, value, sub, strong }: { label: string; value: string; sub: string; strong?: boolean }) {
  return (
    <Card className="flex flex-col gap-1 px-4 py-3.5">
      <span className="text-xs text-muted">{label}</span>
      <span className={cx('display text-[30px] leading-none', strong && 'text-ink')}>{value}</span>
      <span className="text-xs text-muted">{sub}</span>
    </Card>
  );
}

const TAGS = {
  accent: 'bg-tint text-accent-ink',
  blue: 'bg-[#E3ECF7] text-[#1F3F6E]',
  ink: 'bg-ink text-white',
  good: 'bg-good-bg text-good',
};

function Node({ tag, tone, title, sub, to }: { tag: string; tone: keyof typeof TAGS; title: string; sub: string; to?: { flow: string } }) {
  const tenant = useTenant();
  const body = (
    <>
      <span className={cx('w-[64px] shrink-0 rounded-[7px] py-[5px] text-center text-[11px] font-semibold', TAGS[tone])}>{tag}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold">{title}</span>
        <span className="text-xs leading-snug text-muted">{sub}</span>
      </span>
    </>
  );
  const className = 'flex w-full max-w-[400px] items-center gap-3.5 rounded-[14px] bg-paper px-4 py-3.5 shadow-[0_0_0_1px_#12121414,0_6px_16px_-10px_#1212142e]';
  return (
    <li className="flex w-full justify-center">
      {to ? (
        <Link to="/$tenant/flows/$flow/email" params={{ tenant: tenant.id, flow: to.flow }} className={cx(className, 'transition hover:shadow-lift')}>
          {body}
        </Link>
      ) : (
        <div className={className}>{body}</div>
      )}
    </li>
  );
}

function Wire() {
  return (
    <li aria-hidden className="flex h-7 flex-col items-center">
      <span className="w-px flex-1 bg-[#C8C7C2]" />
      <span className="size-1.5 rounded-full bg-[#C8C7C2]" />
    </li>
  );
}

function NextSend({ flow }: { flow: FlowDetail }) {
  const next = flow.next;
  const people = next.people;
  return (
    <Card className="flex flex-col gap-3.5 self-start p-[18px]">
      <div className="flex flex-col gap-1">
        <span className="eyebrow">{flow.live ? 'Next send' : 'If it were on now'}</span>
        <span className="display text-[20px] leading-tight">
          {next.fill ? longDay(next.fill.day) : next.total ? `${nf.format(next.total)} ${next.total === 1 ? 'client' : 'clients'}` : 'Nobody yet'}
        </span>
        <span className="text-xs text-muted">
          {next.fill
            ? `${next.fill.open} free ${next.fill.open === 1 ? 'slot' : 'slots'}, offered to ${nf.format(next.total)} ${next.total === 1 ? 'client' : 'clients'}`
            : next.total
              ? flow.live
                ? 'In the next hourly run, during your daytime'
                : 'Switch it on and they get it within the hour'
              : flow.kind === 'fill_slots'
                ? 'It sends when a day in its window has enough gaps'
                : 'It sends as soon as someone is due'}
        </span>
      </div>
      {next.fill && next.fill.times.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {next.fill.times.map((t) => (
            <span key={t} className="rounded-full px-2.5 py-1 text-xs font-semibold shadow-ring">
              {t}
            </span>
          ))}
        </div>
      )}
      {people.length > 0 && (
        <>
          <span className="text-xs font-semibold">First in line</span>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {people.map((p, i) => (
              <li key={p.email} className="flex items-center gap-2.5 text-[13px]">
                <span
                  className="grid size-7 shrink-0 place-items-center rounded-full text-[10.5px] font-semibold"
                  style={{ background: TINTS[i % TINTS.length]![0], color: TINTS[i % TINTS.length]![1] }}
                >
                  {initialsOf(p)}
                </span>
                <span className="min-w-0 flex-1 truncate">{nameOf(p)}</span>
                <span className={cx('shrink-0 text-xs', p.dueAt && new Date(p.dueAt).getTime() < Date.now() ? 'text-accent-ink' : 'text-muted')}>
                  {flow.kind === 'welcome' || flow.kind === 'winback' ? sinceText(p.lastVisit) : dueText(p.dueAt)}
                </span>
              </li>
            ))}
          </ul>
          {next.total > people.length && <span className="text-xs text-muted">and {nf.format(next.total - people.length)} more</span>}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- one flow

export function FlowPage() {
  const tenant = useTenant();
  const { flow: id } = useParams({ from: '/$tenant/flows/$flow/email' });
  const { data: flow } = useSuspenseQuery(flowQuery(tenant.id, id));
  return <FlowEditor key={flow.id} flow={flow} />;
}

type Draft = { subject: string; content: EmailDoc; settings: Record<string, number> };

function FlowEditor({ flow }: { flow: FlowDetail }) {
  const tenant = useTenant();
  const save = useSaveFlow(tenant.id, flow.id);
  const toggle = useSaveFlow(tenant.id, flow.id);
  const reset = useResetFlow(tenant.id, flow.id);
  const [draft, setDraft] = useState<Draft>({ subject: flow.subject, content: flow.content, settings: flow.settings });

  // Saves a moment after the last change, as campaigns do.
  const draftKey = JSON.stringify(draft);
  const [savedKey, setSavedKey] = useState(draftKey);
  useEffect(() => {
    if (draftKey === savedKey) return;
    const t = setTimeout(() => save.mutate(JSON.parse(draftKey) as Draft, { onSuccess: () => setSavedKey(draftKey) }), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, savedKey]);
  const dirty = draftKey !== savedKey;
  const setContent = (content: Partial<EmailDoc>) => setDraft((d) => ({ ...d, content: { ...d.content, ...content } }));
  // Both saving and the switch put the fresh flow in the query cache, which is `flow` here.
  const current = flow;

  return (
    <>
      <Link to="/$tenant/flows/$flow" params={{ tenant: tenant.id, flow: flow.id }} className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft size={14} /> {flow.name}
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="display m-0 flex items-center gap-3 text-[34px] leading-[1.05]">{flow.name}</h1>
          <span className="text-[13px] text-muted">
            {save.isError ? <span className="text-bad">Not saved: {save.error.message}</span> : dirty || save.isPending ? 'Saving…' : 'All changes saved'}
            {' · '}From {current.sender.from}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={() =>
              reset.mutate(undefined, {
                onSuccess: (fresh) => {
                  const next = { subject: fresh.subject, content: fresh.content, settings: draft.settings };
                  setDraft(next);
                  setSavedKey(JSON.stringify(next));
                },
              })
            }
            disabled={reset.isPending}
          >
            <RotateCcw size={14} /> Our wording
          </Button>
          <label className="flex items-center gap-2.5 rounded-full border border-rule-strong bg-paper py-1.5 pr-1.5 pl-3.5 text-[13px] font-medium">
            {current.live ? 'On' : 'Off'}
            <Switch checked={current.live} label="Send this flow" disabled={toggle.isPending || dirty} onChange={(live) => toggle.mutate({ live })} />
          </label>
        </div>
      </div>
      {toggle.isError && <Notice tone="bad">{toggle.error.message}</Notice>}
      {!current.live && current.problems.length > 0 && !dirty && (
        <Notice>
          Before it can go on: {current.problems[0]}
          {current.problems.length > 1 && ` (and ${current.problems.length - 1} more)`}
        </Notice>
      )}

      <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="flex flex-col gap-4 px-5 py-5">
            <CardTitle aside={flow.waiting ? `${nf.format(flow.waiting)} due now` : 'Nobody due now'}>When it sends</CardTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.entries(flow.fields).map(([key, field]) => (
                <label key={key} className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted">{field.label}</span>
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    value={draft.settings[key] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, settings: { ...d.settings, [key]: Number(e.target.value) } }))}
                    className={cx(control, 'w-28')}
                  />
                </label>
              ))}
            </div>
          </Card>
          <Card className="flex flex-col gap-4 px-5 py-5">
            <TagField label="Subject line" value={draft.subject} onChange={(subject) => setDraft((d) => ({ ...d, subject }))} />
            <TagField label="Preview text" hint="Shown after the subject in most inboxes." value={draft.content.preview} onChange={(preview) => setContent({ preview })} />
          </Card>
          <BlocksCard blocks={draft.content.blocks} onChange={(blocks) => setContent({ blocks })} />
        </div>
        <Preview content={draft.content} subject={draft.subject} render={(content) => previewFlow(tenant.id, flow.id, content)} renderKey={flow.id} />
      </div>
    </>
  );
}

function FlowResults({ flow }: { flow: FlowDetail }) {
  return (
    <Card className="px-5 py-4">
        <CardTitle>Latest sends</CardTitle>
        {flow.recent.length === 0 ? (
          <p className="mt-3 mb-1 text-[13px] text-muted">Nothing sent yet. Each client this flow emails appears here, with why.</p>
        ) : (
          <ul className="mt-1.5">
            {flow.recent.slice(0, 8).map((r) => (
              <li key={`${r.email}-${r.reason}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 border-t border-rule py-[9px] first:border-t-0">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{[r.firstName, r.lastName].filter(Boolean).join(' ') || r.email}</span>
                  <span className="truncate text-xs text-muted">
                    {reasonText(r.reason)} · {when(r.at)}
                  </span>
                </span>
                {r.status && <StatusBadge status={r.status} />}
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}
