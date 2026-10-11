import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowDownRight, ArrowUpRight, Check } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { activityQuery, meQuery, overviewQuery, type Activity, type Opportunity, type Overview } from '../api.ts';
import { AreaChart, Sparkline, soften } from '../components/charts.tsx';
import { money } from '../components/email-editor.tsx';
import { GettingStarted, PlanNotice } from '../components/getting-started.tsx';
import { useTenant } from '../components/Shell.tsx';
import { Card, CardTitle, Segmented, cx } from '../components/ui.tsx';

const nf = new Intl.NumberFormat('en-GB');
const pct = (n: number) => `${n < 1 && n > 0 ? n.toFixed(2) : n.toFixed(1)}%`;

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** Rates as SES measures them: out of emails that actually left, not ones we held back. */
export function health(stats: Activity['stats']) {
  const n = (k: keyof Activity['stats']) => stats[k] ?? 0;
  const attempted = n('sent') + n('delivered') + n('delivery_delayed') + n('bounced') + n('complained') + n('rejected') + n('failed');
  const reported = n('delivered') + n('bounced') + n('complained');
  const rate = (x: number) => (attempted ? (x / attempted) * 100 : 0);
  return {
    attempted,
    reported,
    held: n('suppressed'),
    delivered: rate(n('delivered') + n('complained')),
    bounce: rate(n('bounced')),
    complaint: rate(n('complained')),
  };
}

const weekdayOf = (day: string, style: 'long' | 'short' = 'short') =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: style, timeZone: 'UTC' });

type Period = '7' | '30' | '90';

export function Home() {
  const tenant = useTenant();
  const [period, setPeriod] = useState<Period>('30');
  const { data: activity } = useSuspenseQuery(activityQuery(tenant.id));
  const { data: overview } = useQuery({ ...overviewQuery(tenant.id, Number(period)), placeholderData: keepPreviousData });
  const { data: me } = useQuery(meQuery);
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <>
      <section className="flex flex-wrap items-end justify-between gap-4 px-1 pt-3">
        <div className="flex flex-col gap-2">
          <span className="eyebrow">{today}</span>
          <h1 className="display m-0 text-[44px] leading-none">{me ? `${greeting()}, ${me.user.name.split(' ')[0]}` : tenant.name}</h1>
          <p className="m-0 max-w-[640px] text-[15px] leading-normal text-[#55555C]">{overview ? <Headline overview={overview} /> : ' '}</p>
        </div>
        <Segmented
          label="Period"
          value={period}
          onChange={setPeriod}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ]}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-12">
        <PlanNotice tenant={tenant.id} />
        <GettingStarted tenant={tenant.id} />
        <MoneyCard overview={overview} className="lg:col-span-7" />
        <WeekAhead overview={overview} className="lg:col-span-5" />

        <section aria-labelledby="todo" className="flex flex-col gap-3 pt-1.5 lg:col-span-12">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
            <h2 id="todo" className="display m-0 text-[22px]">
              Worth doing today
            </h2>
            <span className="text-[13px] text-muted">From your diary, your clients’ rhythms and recent results</span>
          </div>
          <div className={cx('grid gap-4', overview?.opportunities.length === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3')}>
            {overview?.opportunities.map((o, i) => <OpportunityCard key={o.kind} opportunity={o} n={i + 1} />)}
            {overview && overview.opportunities.length === 0 && (
              <Card className="flex items-center gap-3 px-5 py-5 md:col-span-3">
                <span className="flex size-8 items-center justify-center rounded-full bg-good-bg text-good">
                  <Check size={16} />
                </span>
                <span className="text-sm">
                  <span className="font-semibold">Nothing pressing.</span> <span className="text-muted">
                    Your flows are on{overview.week.connected ? ' and the week ahead is full.' : ' and everyone due back has booked.'}
                  </span>
                </span>
              </Card>
            )}
            {!overview && [0, 1, 2].map((i) => <Card key={i} className="h-[196px] animate-pulse" />)}
          </div>
        </section>

        <FlowsCard overview={overview} className="lg:col-span-7" />
        <HealthCard activity={activity} className="lg:col-span-5" />
      </div>
    </>
  );
}

/** One sentence on the week: the quiet stretch and who could fill it. */
function Headline({ overview }: { overview: Overview }) {
  const q = overview.week.quietest;
  const due = overview.dueCount;
  const people = (
    <strong className="font-semibold text-ink">
      {due} {due === 1 ? 'client' : 'clients'}
    </strong>
  );
  if (q && q.dayOpen >= 2) {
    const named = q.open * 2 > q.dayOpen;
    const slots = named ? q.open : q.dayOpen;
    return (
      <>
        {weekdayOf(q.day, 'long')}
        {named ? ` ${overview.week.parts[q.part]!.toLowerCase()}` : ''} has{' '}
        <strong className="font-semibold text-ink">
          {slots} free {slots === 1 ? 'slot' : 'slots'}
        </strong>
        {due > 0 ? (
          <>
            {' '}
            and {people} {due === 1 ? 'is' : 'are'} due back. One email could fill most of it.
          </>
        ) : (
          '.'
        )}
      </>
    );
  }
  if (due > 0) return <>{people} {due === 1 ? 'is' : 'are'} due back with nothing booked.</>;
  if (!overview.week.connected) {
    const bookings = overview.revenue.bookings > 0 || overview.week.days.some((d) => d.booked > 0);
    if (!bookings) return <>Connect your booking diary and this page fills with the week ahead and who is due back.</>;
    return <>Everyone due back has booked. Free times show here once your booking system is connected.</>;
  }
  return <>The week ahead is full and everyone due back has booked.</>;
}

function MoneyCard({ overview, className }: { overview: Overview | undefined; className?: string }) {
  const [measure, setMeasure] = useState<'revenue' | 'bookings'>('revenue');
  const r = overview?.revenue;
  const series = r?.daily.map((d) => (measure === 'revenue' ? d.revenue : d.bookings)) ?? [];
  const previous = r?.daily.map((d) => (measure === 'revenue' ? d.previous : d.previousBookings)) ?? [];
  const days = overview?.days ?? 30;
  const split = r && r.revenue > 0 ? r.flows / r.revenue : 0;
  return (
    <Card className={cx('flex min-h-[340px] flex-col gap-4 px-6 pt-[22px] pb-[18px]', className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-muted">Booked from email</span>
          <div className="flex items-baseline gap-3">
            <span className="display text-[56px] leading-[0.95]">{r ? (measure === 'revenue' ? money(r.revenue) : nf.format(r.bookings)) : '…'}</span>
            {r?.change != null && (
              <span
                className={cx(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12.5px] font-semibold',
                  r.change >= 0 ? 'bg-good-bg text-good' : 'bg-bad-bg text-bad',
                )}
              >
                {r.change >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                {Math.abs(r.change)}%
              </span>
            )}
          </div>
          <span className="text-[13px] text-muted">
            <span className="num font-semibold text-ink">
              {r ? nf.format(r.bookings) : '…'} {r?.bookings === 1 ? 'appointment' : 'appointments'}
            </span>{' '}
            made within five days of an email
          </span>
        </div>
        <Segmented
          label="Measure"
          size="sm"
          value={measure}
          onChange={setMeasure}
          options={[
            { value: 'revenue', label: 'Revenue' },
            { value: 'bookings', label: 'Bookings' },
          ]}
        />
      </div>
      {r && r.revenue + r.previous + r.bookings > 0 ? (
        <AreaChart
          series={soften(series, days > 30 ? 2 : 1)}
          compare={soften(previous, days > 30 ? 2 : 1)}
          label={`${measure === 'revenue' ? 'Revenue' : 'Bookings'} from email each day over the last ${days} days, against the ${days} days before`}
        />
      ) : (
        <div className="dots flex flex-1 items-center justify-center rounded-xl px-6 text-center text-[13px] text-muted">
          {r ? 'Bookings that follow an email land here, with the money they bring in.' : ''}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <div className="flex h-2 gap-[3px] overflow-hidden rounded-full bg-soft">
          {r && r.revenue > 0 && (
            <>
              <span className="bg-accent" style={{ flex: split }} />
              <span className="bg-accent-light" style={{ flex: 1 - split }} />
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px] bg-accent" />
            Flows <strong className="num text-ink">{r ? money(r.flows) : '…'}</strong>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px] bg-accent-light" />
            Campaigns <strong className="num text-ink">{r ? money(r.campaigns) : '…'}</strong>
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="w-3.5 border-t-[1.6px] border-dashed border-faint" />
            Previous {days} days
          </span>
        </div>
      </div>
    </Card>
  );
}

/** A sample week so the shape of Home is right before a diary is connected. */
const SAMPLE_WEEK: Overview['week'] = (() => {
  const grid = [
    [0, 0, 0, 0],
    [2, 4, 5, 0],
    [0, 1, 1, 0],
    [2, 3, 4, 1],
    [0, 2, 2, 0],
    [0, 0, 1, 0],
    [-1, -1, -1, -1],
  ];
  const start = Date.now();
  return {
    connected: false,
    timezone: 'Europe/London',
    parts: ['Morning', 'Midday', 'Afternoon', 'Evening'],
    quietest: null,
    days: grid.map((row, i) => {
      const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      const parts = row.map((open) => (open < 0 ? { open: 0, booked: 0 } : { open, booked: 4 }));
      return { day, parts, open: parts.reduce((a, p) => a + p.open, 0), booked: parts.reduce((a, p) => a + p.booked, 0) };
    }),
  };
})();

function WeekAhead({ overview, className }: { overview: Overview | undefined; className?: string }) {
  const live = overview?.week.connected ?? false;
  const week = live ? overview!.week : SAMPLE_WEEK;
  const totalOpen = week.days.reduce((sum, d) => sum + d.open, 0);
  const most = Math.max(1, ...week.days.flatMap((d) => d.parts.map((p) => p.open)));
  const q = week.quietest;
  return (
    <Card className={cx('flex flex-col gap-3.5 px-[22px] pt-[22px] pb-[18px]', className)}>
      <CardTitle aside={live ? <span className="num">{totalOpen} free {totalOpen === 1 ? 'slot' : 'slots'}</span> : <span className="rounded-full bg-soft px-2 py-0.5 text-xs">Example week</span>}>
        The week ahead
      </CardTitle>
      <div
        role="table"
        aria-label="Free slots for each part of the next seven days"
        className="grid flex-1 gap-[5px] text-[11.5px]"
        style={{ gridTemplateColumns: `64px repeat(${week.days.length}, minmax(0, 1fr))` }}
      >
        <div role="row" className="contents">
          <span role="cell" />
          {week.days.map((d) => (
            <span key={d.day} role="columnheader" className={cx('text-center', q?.day === d.day ? 'font-bold text-accent-ink' : 'text-faint')}>
              {weekdayOf(d.day)}
            </span>
          ))}
        </div>
        {week.parts.map((part, pi) => (
          <div key={part} role="row" className="contents">
            <span role="rowheader" className="self-center text-faint">
              {part}
            </span>
            {week.days.map((d) => {
              const cell = d.parts[pi]!;
              const hot = q?.day === d.day && q.part === pi;
              const closed = cell.open + cell.booked === 0;
              const strength = cell.open / most;
              const style: CSSProperties = closed
                ? { background: 'var(--soft)' }
                : cell.open === 0
                  ? { background: '#E4E3DF' }
                  : { background: `color-mix(in oklab, var(--accent) ${Math.round(18 + strength * 82)}%, var(--tint))`, color: strength > 0.55 ? 'var(--on-accent)' : 'var(--accent-ink)' };
              return (
                <span
                  key={d.day}
                  role="cell"
                  aria-label={`${weekdayOf(d.day, 'long')} ${part.toLowerCase()}: ${closed ? 'closed' : cell.open ? `${cell.open} free` : 'fully booked'}`}
                  className={cx('flex h-10 items-center justify-center rounded-lg font-semibold', hot && 'font-bold')}
                  style={hot ? { ...style, boxShadow: '0 0 0 2px var(--paper), 0 0 0 3.5px var(--accent)' } : style}
                >
                  {cell.open || ''}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3.5 text-[11.5px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ background: 'color-mix(in oklab, var(--accent) 60%, var(--tint))' }} />
          Free slots
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-[#E4E3DF]" />
          Fully booked
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-soft" />
          Closed
        </span>
        {!live && <span className="basis-full text-faint">Your own free times show here once your booking system is connected.</span>}
      </div>
    </Card>
  );
}

const AVATAR_TINTS = [
  ['#F3D9CC', '#6E2512'],
  ['#DCE7F3', '#1F3F6E'],
  ['#E3EEDF', '#2D5A22'],
];

function OpportunityCard({ opportunity: o, n }: { opportunity: Opportunity; n: number }) {
  const tenant = useTenant();
  const first = n === 1;
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <span className={cx('display flex size-[30px] items-center justify-center rounded-[10px] text-[15px]', first ? 'bg-accent text-on-accent' : 'bg-ink text-white')}>{n}</span>
        {o.value ? (
          <span className="num text-[12.5px] font-semibold text-good">
            Up to {money(o.value)} {o.note}
          </span>
        ) : (
          <span className="text-[12.5px] text-muted">{o.note}</span>
        )}
      </div>
      <h3 className="m-0 text-base leading-snug font-semibold">{o.title}</h3>
      <p className="m-0 text-[13.5px] leading-normal text-[#55555C]">{o.detail}</p>
      <div className="mt-auto flex items-center gap-1.5 pt-1">
        {o.people && o.people.initials.length > 0 && (
          <>
            <span className="flex">
              {o.people.initials.map((p, i) => (
                <span
                  key={i}
                  className={cx('flex size-[26px] items-center justify-center rounded-full border-2 border-paper text-[10px] font-semibold', i > 0 && '-ml-2')}
                  style={{ background: AVATAR_TINTS[i % 3]![0], color: AVATAR_TINTS[i % 3]![1] }}
                >
                  {p}
                </span>
              ))}
            </span>
            {o.people.more > 0 && <span className="text-[12.5px] text-muted">+{o.people.more}</span>}
          </>
        )}
        {o.action.flowId ? (
          <Link
            to="/$tenant/flows/$flow"
            params={{ tenant: tenant.id, flow: o.action.flowId }}
            className={cx('ml-auto inline-flex h-[34px] items-center rounded-full px-4 text-[13px] font-medium whitespace-nowrap', first ? 'bg-ink text-white' : 'bg-paper text-ink shadow-ring')}
          >
            {o.action.label}
          </Link>
        ) : o.action.campaignId ? (
          <Link
            to="/$tenant/campaigns/$campaign"
            params={{ tenant: tenant.id, campaign: o.action.campaignId }}
            className="ml-auto inline-flex h-[34px] items-center rounded-full bg-paper px-4 text-[13px] font-medium whitespace-nowrap text-ink shadow-ring"
          >
            {o.action.label}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

function FlowsCard({ overview, className }: { overview: Overview | undefined; className?: string }) {
  const tenant = useTenant();
  const navigate = useNavigate();
  const days = overview?.days ?? 30;
  return (
    <Card className={cx('px-[22px] pt-5 pb-2', className)}>
      <CardTitle
        aside={
          <Link to="/$tenant/flows" params={{ tenant: tenant.id }} className="hover:text-ink">
            All flows
          </Link>
        }
      >
        Flows working for you
      </CardTitle>
      <div role="table" className="mt-1.5 grid grid-cols-[minmax(0,1fr)_120px_64px_80px] items-center gap-x-4 text-[13.5px]">
        <div role="row" className="contents">
          <span role="columnheader" className="eyebrow py-2">
            Flow
          </span>
          <span role="columnheader" className="eyebrow">
            Sent, {days} days
          </span>
          <span role="columnheader" className="eyebrow text-right">
            Booked
          </span>
          <span role="columnheader" className="eyebrow text-right">
            Value
          </span>
        </div>
        {overview?.flows.map((f) => (
          <div
            key={f.id}
            role="row"
            className="group contents cursor-pointer"
            onClick={() => void navigate({ to: '/$tenant/flows/$flow', params: { tenant: tenant.id, flow: f.id } })}
          >
            <span role="cell" className="flex items-center gap-2.5 border-t border-rule py-3 group-hover:text-accent-ink">
              <span aria-hidden="true" className={cx('size-2 shrink-0 rounded-full', f.live ? 'bg-[#2E8B57]' : 'bg-[#C8C7C2]')} />
              <Link to="/$tenant/flows/$flow" params={{ tenant: tenant.id, flow: f.id }} className={cx('truncate', !f.live && 'text-muted')}>
                {f.name}
                {!f.live && <span className="sr-only"> (off)</span>}
              </Link>
            </span>
            <span role="cell" className="flex h-full items-center border-t border-rule">
              {f.live || f.sent ? <Sparkline values={f.daily} muted={!f.live} label={`${f.sent} sent`} /> : <span className="text-[12.5px] text-faint">Off</span>}
            </span>
            <span role="cell" className={cx('num border-t border-rule py-3 text-right', !f.bookings && 'text-faint')}>
              {f.bookings || '–'}
            </span>
            <span role="cell" className={cx('num border-t border-rule py-3 text-right font-semibold', !f.revenue && 'font-normal text-faint')}>
              {f.revenue ? money(f.revenue) : '–'}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function HealthCard({ activity, className }: { activity: Activity; className?: string }) {
  const tenant = useTenant();
  const h = health(activity.stats);
  const tone = (good: boolean, warn: boolean) => (!h.attempted ? 'neutral' : good ? 'good' : warn ? 'warn' : 'bad');
  const bounceTone = tone(h.bounce < 2, h.bounce < 4);
  const spamTone = tone(h.complaint < 0.1, h.complaint < 0.3);
  const overall = tenant.status === 'paused' ? 'bad' : [bounceTone, spamTone].includes('bad') ? 'bad' : [bounceTone, spamTone].includes('warn') ? 'warn' : 'good';
  // The marker sits on a 0 to 5% bounce scale: green under 2, amber to 4, red where we pause.
  const marker = Math.min(100, (h.bounce / 5) * 100);
  return (
    <Card className={cx('flex flex-col gap-3.5 px-[22px] py-5', className)}>
      <CardTitle
        aside={
          <span className={cx('inline-flex items-center gap-1.5 font-semibold', overall === 'good' ? 'text-good' : overall === 'warn' ? 'text-warn' : 'text-bad')}>
            <span className={cx('size-[7px] rounded-full', overall === 'good' ? 'bg-[#2E8B57]' : overall === 'warn' ? 'bg-warn' : 'bg-bad')} />
            {tenant.status === 'paused' ? 'Paused' : overall === 'good' ? 'All good' : 'Keep an eye on it'}
          </span>
        }
      >
        Sending health
      </CardTitle>
      <div className="grid grid-cols-3 gap-3">
        <HealthStat label="Reached inbox" value={h.reported ? pct(h.delivered) : '–'} />
        <HealthStat label="Bounced" value={h.attempted ? pct(h.bounce) : '–'} tone={bounceTone} />
        <HealthStat label="Spam reports" value={h.attempted ? pct(h.complaint) : '–'} tone={spamTone} />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="relative h-1.5 rounded-full" style={{ background: 'linear-gradient(90deg, #CFE6D7 0 40%, #F6E3B8 40% 80%, #F3C9C0 80%)' }}>
          {h.attempted > 0 && <span className="absolute -top-1 h-3.5 w-1 -translate-x-1/2 rounded-sm bg-ink" style={{ left: `${marker}%` }} />}
        </div>
        <span className="text-xs leading-snug text-muted">
          {!h.attempted
            ? 'Rates appear once your first emails go out.'
            : h.bounce < 4
              ? `Bounces are under the 4% where we pause sending to protect you. ${nf.format(h.attempted)} sent in 30 days.`
              : 'Bounces are near the line where we pause sending. Clean the list before the next campaign.'}
        </span>
      </div>
    </Card>
  );
}

function HealthStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <span className={cx('display text-[28px] leading-tight', tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn')}>{value}</span>
    </div>
  );
}
