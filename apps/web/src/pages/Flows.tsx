import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, CalendarHeart, CalendarPlus, HeartHandshake, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  diaryQuery,
  flowQuery,
  flowsQuery,
  previewFlow,
  useResetFlow,
  useSaveFlow,
  useToggleFlow,
  type EmailDoc,
  type Flow,
  type FlowDetail,
  type FlowKind,
} from '../api.ts';
import { BlocksCard, Booked, Preview, Stat, TagField, control, money } from '../components/email-editor.tsx';
import { useTenant } from '../components/Shell.tsx';
import { Button, Card, CardTitle, Notice, PageTitle, StatusBadge, Switch, cx } from '../components/ui.tsx';
import { inStudio } from '../studio.ts';
import { rate, when } from './Campaigns.tsx';

const nf = new Intl.NumberFormat('en-GB');

const ICONS: Record<FlowKind, ReactNode> = {
  welcome: <Sparkles size={18} />,
  rebook: <CalendarHeart size={18} />,
  fill_slots: <CalendarPlus size={18} />,
  winback: <HeartHandshake size={18} />,
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

// ---------------------------------------------------------------- the list

export function Flows() {
  const tenant = useTenant();
  const { data: flows } = useSuspenseQuery(flowsQuery(tenant.id));
  const { data: diary } = useQuery(diaryQuery(tenant.id));
  const booked = flows.reduce((sum, f) => sum + f.stats.bookings, 0);
  const revenue = flows.reduce((sum, f) => sum + f.stats.revenue, 0);
  const liveCount = flows.filter((f) => f.live).length;

  return (
    <>
      <PageTitle
        title="Flows"
        subtitle={
          liveCount ? (
            <>
              {liveCount} of {flows.length} on. <span className="font-semibold text-ink">{booked} bookings</span> ({money(revenue)}) followed a flow email in the
              last 90 days.
            </>
          ) : (
            'Emails that send themselves, timed by your diary. Switch one on and it looks after itself.'
          )
        }
      />
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
      <div className="grid gap-4 @3xl:grid-cols-2">
        {flows.map((flow) => (
          <FlowCard key={flow.id} flow={flow} />
        ))}
      </div>
      <p className="m-0 text-xs leading-relaxed text-muted">
        Flows send between 9am and 7pm your time, only to clients who said yes to news, and never more than one marketing email in three days per client,
        campaigns included.
      </p>
    </>
  );
}

function FlowCard({ flow }: { flow: Flow }) {
  const tenant = useTenant();
  const toggle = useToggleFlow(tenant.id);
  const s = flow.stats;
  return (
    <Card className={cx('flex flex-col gap-4 px-5 py-5', flow.live && 'border-accent/40')}>
      <div className="flex items-start gap-3">
        <span className={cx('grid size-10 shrink-0 place-items-center rounded-xl', flow.live ? 'bg-tint text-accent-ink' : 'bg-soft text-muted')}>{ICONS[flow.kind]}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="display m-0 text-[19px] leading-tight">{flow.name}</h2>
          <p className="m-0 text-[13px] leading-relaxed text-muted">{flow.description}</p>
        </div>
        <Switch
          checked={flow.live}
          label={`${flow.name} ${flow.live ? 'on' : 'off'}`}
          disabled={toggle.isPending}
          onChange={(live) => toggle.mutate({ id: flow.id, live })}
        />
      </div>
      {toggle.isError && toggle.variables?.id === flow.id && <Notice tone="bad">{toggle.error.message}</Notice>}
      <div className="grid grid-cols-4 gap-2 border-t border-rule pt-3.5">
        <Mini label="Sent" value={nf.format(s.sent)} />
        <Mini label="Opened" value={rate(s.opened, s.sent)} />
        <Mini label="Booked" value={nf.format(s.bookings)} strong={s.bookings > 0} />
        <Mini label="Value" value={money(s.revenue)} strong={s.revenue > 0} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] text-muted">
          {flow.waiting > 0 ? (
            <>
              <span className="font-semibold text-ink">{nf.format(flow.waiting)}</span> {flow.waiting === 1 ? 'client' : 'clients'} {flow.live ? 'due an email' : 'would get it now'}
            </>
          ) : (
            'Nobody due right now'
          )}
        </span>
        <Link
          to="/$tenant/flows/$flow"
          params={{ tenant: tenant.id, flow: flow.id }}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink hover:underline"
        >
          Email and timing <ArrowRight size={14} />
        </Link>
      </div>
    </Card>
  );
}

function Mini({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted">{label}</span>
      <span className={cx('text-[15px] tabular-nums', strong ? 'font-semibold text-ink' : 'text-ink')}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------- one flow

export function FlowPage() {
  const tenant = useTenant();
  const { flow: id } = useParams({ from: '/$tenant/flows/$flow' });
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
      <Link to="/$tenant/flows" params={{ tenant: tenant.id }} className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft size={14} /> Flows
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

      <FlowResults flow={current} />
    </>
  );
}

function FlowResults({ flow }: { flow: FlowDetail }) {
  const s = flow.stats;
  return (
    <section className="flex flex-col gap-4">
      <h2 className="display m-0 text-[22px]">How it is doing</h2>
      <Booked bookings={s.bookings} revenue={s.revenue} />
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Sent" value={nf.format(s.sent)} sub="in all" />
        <Stat label="Opened" value={rate(s.opened, s.sent)} sub={`${nf.format(s.opened)} people`} />
        <Stat label="Clicked" value={rate(s.clicked, s.sent)} sub={`${nf.format(s.clicked)} people`} />
      </div>
      <Card className="px-5 py-4">
        <CardTitle>Latest</CardTitle>
        {flow.recent.length === 0 ? (
          <p className="mt-3 mb-1 text-[13px] text-muted">Nothing sent yet. Each client this flow emails appears here, with why.</p>
        ) : (
          <ul className="mt-1.5">
            {flow.recent.map((r) => (
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
    </section>
  );
}
