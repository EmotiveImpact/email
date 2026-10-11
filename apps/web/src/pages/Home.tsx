import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { activityQuery, meQuery, type Activity } from '../api.ts';
import { AreaChart, soften } from '../components/charts.tsx';
import { useTenant } from '../components/Shell.tsx';
import { Card, CardTitle, PageTitle, StatusBadge, cx } from '../components/ui.tsx';

const nf = new Intl.NumberFormat('en-GB');
const pct = (n: number) => `${n < 1 && n > 0 ? n.toFixed(2) : n.toFixed(1)}%`;
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

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

export function Home() {
  const tenant = useTenant();
  const { data } = useSuspenseQuery(activityQuery(tenant.id));
  const { data: me } = useQuery(meQuery);
  const total = data.daily.reduce((sum, d) => sum + d.total, 0);
  const h = health(data.stats);
  // Today is still filling up, so the line stops at yesterday rather than dipping every morning.
  const past = data.daily.slice(0, -1);
  const first = past[0];
  const mid = past[Math.floor(past.length / 2)];
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <>
      <PageTitle
        title={me ? `${greeting()}, ${me.user.name.split(' ')[0]}` : tenant.name}
        subtitle={
          <>
            {today}. <span className="font-semibold text-ink">{nf.format(total)} emails</span> in the last 30 days
            {h.held > 0 && <>, {nf.format(h.held)} held back to protect your sending</>}.
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1.75fr_1fr]">
        <Card className="flex h-[292px] flex-col px-[22px] pt-5 pb-3.5">
          <div className="flex items-start justify-between">
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] text-muted">Emails sent</span>
              <div className="flex items-center gap-3">
                <span className="display text-[50px] leading-none">{nf.format(total)}</span>
                {h.reported > 0 && (
                  <span className="rounded-full bg-good-bg px-2.5 py-1 text-[13px] font-semibold text-good">{pct(h.delivered)} delivered</span>
                )}
              </div>
              <span className="text-[13px] text-muted">Last 30 days, every stream</span>
            </div>
            <div className="flex gap-4 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <span className="h-[3px] w-3.5 rounded-sm bg-accent" />
                Sent
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3.5 border-t-2 border-dashed border-faint" />
                Delivered
              </span>
            </div>
          </div>
          <AreaChart
            series={soften(past.map((d) => d.total))}
            compare={soften(past.map((d) => d.delivered))}
            label={`Emails sent each day over the last 30 days, ${nf.format(total)} in all`}
          />
          <div className="flex justify-between pt-2 text-xs text-faint">
            <span>{first && dayLabel(first.day)}</span>
            <span>{mid && dayLabel(mid.day)}</span>
            <span>Yesterday</span>
          </div>
        </Card>
        <DiaryStrip />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <HealthTile
          label="Reached the inbox"
          value={h.reported ? pct(h.delivered) : '—'}
          note={h.reported ? `of ${nf.format(h.attempted)} sent` : 'No delivery reports yet'}
          tone={!h.reported ? 'neutral' : h.delivered >= 97 ? 'good' : h.delivered >= 90 ? 'warn' : 'bad'}
        />
        <HealthTile
          label="Bounced"
          value={h.attempted ? pct(h.bounce) : '—'}
          note="Amazon reviews accounts above 5%. Keep it under 2%."
          tone={!h.attempted ? 'neutral' : h.bounce < 2 ? 'good' : h.bounce < 5 ? 'warn' : 'bad'}
        />
        <HealthTile
          label="Marked as spam"
          value={h.attempted ? pct(h.complaint) : '—'}
          note="Gmail and Yahoo act above 0.3%. Keep it under 0.1%."
          tone={!h.attempted ? 'neutral' : h.complaint < 0.1 ? 'good' : h.complaint < 0.3 ? 'warn' : 'bad'}
        />
      </div>

      <Card className="px-5 py-4">
        <CardTitle
          aside={
            <Link to="/$tenant/sending" params={{ tenant: tenant.id }} className="hover:text-ink">
              View all
            </Link>
          }
        >
          Latest emails
        </CardTitle>
        {data.messages.length === 0 ? (
          <p className="mt-3 mb-1 text-[13px] text-muted">Nothing sent yet. Emails from your apps appear here as they go out.</p>
        ) : (
          <ul className="mt-1.5">
            {data.messages.slice(0, 5).map((m) => (
              <li key={m.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 border-t border-rule py-[9px] first:border-t-0">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{m.subject}</span>
                  <span className="truncate text-xs text-muted">
                    {m.to} · {m.stream === 'marketing' ? 'News' : 'Service'}
                  </span>
                </span>
                <StatusBadge status={m.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function HealthTile({ label, value, note, tone }: { label: string; value: string; note: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }) {
  return (
    <Card className="flex flex-col gap-1 px-[18px] py-4">
      <span className="flex items-center gap-2 text-[13px] text-muted">
        <span
          aria-hidden
          className={cx('size-2 rounded-full', tone === 'good' && 'bg-good', tone === 'warn' && 'bg-warn', tone === 'bad' && 'bg-bad', tone === 'neutral' && 'bg-rule-strong')}
        />
        {label}
      </span>
      <span className="display text-[28px] leading-tight">{value}</span>
      <span className="text-xs leading-snug text-muted">{note}</span>
    </Card>
  );
}

/** Sample until the diary sync lands (Saleane first). Shown so the shape of Home is right from day one. */
const WEEK: [string, number, number][] = [
  ['Mon', 2, 26],
  ['Tue', 7, 21],
  ['Wed', 4, 24],
  ['Thu', 9, 19],
  ['Fri', 3, 25],
  ['Sat', 0, 30],
  ['Sun', 0, 0],
];

function DiaryStrip() {
  const tenant = useTenant();
  const busiest = WEEK.reduce((a, b) => (b[1] > a[1] ? b : a));
  return (
    <Card className="flex h-[292px] flex-col gap-3 px-[22px] py-5">
      <CardTitle aside={<span className="rounded-full bg-soft px-2 py-0.5 text-xs">Sample diary</span>}>Your next 7 days</CardTitle>
      <div role="img" aria-label="Booked and empty slots for each of the next seven days" className="flex min-h-0 flex-1 items-stretch gap-2">
        {WEEK.map(([day, empty, booked]) => {
          const closed = empty + booked === 0;
          const hot = day === busiest[0];
          return (
            <div key={day} className="flex flex-1 flex-col items-center gap-1.5">
              <span className={cx('text-xs font-semibold', hot ? 'text-accent-ink' : closed || !empty ? 'text-faint' : 'text-ink')}>
                {closed ? 'Shut' : empty || '✓'}
              </span>
              <div
                className="flex w-full max-w-[30px] grow flex-col overflow-hidden rounded-lg bg-soft"
                style={hot ? { boxShadow: '0 0 0 2px var(--tint), 0 0 0 3px var(--accent)' } : undefined}
              >
                {!closed && (
                  <>
                    <div
                      style={{
                        flex: `${empty} 1 0`,
                        opacity: hot ? 1 : 0.75,
                        background: 'repeating-linear-gradient(135deg, var(--accent) 0 2px, var(--tint) 2px 6px)',
                      }}
                    />
                    <div style={{ flex: `${booked} 1 0` }} className="bg-[#DAD9D5]" />
                  </>
                )}
              </div>
              <span className={cx('text-xs', hot ? 'font-semibold text-ink' : 'text-muted')}>{day}</span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2.5 border-t border-rule pt-2">
        <span className="text-[13px] leading-snug">
          <span className="font-semibold">Empty slots</span> <span className="text-muted">appear here once your booking diary is connected</span>
        </span>
        <Link
          to="/$tenant/flows"
          params={{ tenant: tenant.id }}
          className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[13px] font-medium whitespace-nowrap text-white"
        >
          Fill the gaps <ArrowRight size={14} />
        </Link>
      </div>
    </Card>
  );
}
