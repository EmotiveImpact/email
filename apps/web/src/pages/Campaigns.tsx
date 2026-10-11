import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { CalendarClock, Plus } from 'lucide-react';
import { useState } from 'react';
import { campaignsQuery, playsQuery, segmentsQuery, useCreateCampaign, type Campaign, type CampaignStatus, type Play } from '../api.ts';
import { useTenant } from '../components/Shell.tsx';
import { Sheet, money } from '../components/email-editor.tsx';
import { Button, Card, Notice, PageTitle, Segmented, cx } from '../components/ui.tsx';

const nf = new Intl.NumberFormat('en-GB');
export const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Out of emails that arrived, as most email tools count it. */
export const rate = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '–');

const LABEL: Record<CampaignStatus, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'bg-soft text-muted' },
  scheduled: { label: 'Scheduled', tone: 'bg-tint text-ink' },
  sending: { label: 'Sending', tone: 'bg-warn-bg text-warn' },
  sent: { label: 'Sent', tone: 'bg-good-bg text-good' },
};

export function CampaignBadge({ status }: { status: CampaignStatus }) {
  const { label, tone } = LABEL[status];
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs font-medium whitespace-nowrap', tone)}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

type Filter = 'all' | 'draft' | 'scheduled' | 'sent';

export function Campaigns() {
  const tenant = useTenant();
  const { data: campaigns } = useSuspenseQuery(campaignsQuery(tenant.id));
  const { data: segments = [] } = useQuery(segmentsQuery(tenant.id));
  const [filter, setFilter] = useState<Filter>('all');
  const create = useCreateCampaign(tenant.id);
  const navigate = useNavigate();
  const shown = campaigns.filter((c) => filter === 'all' || c.status === filter || (filter === 'sent' && c.status === 'sending'));
  const count = (f: Filter) => campaigns.filter((c) => c.status === f || (f === 'sent' && c.status === 'sending')).length;
  const segmentName = (id: string | null) => (id ? (segments.find((s) => s.id === id)?.name ?? 'A deleted segment') : 'Everyone who said yes');

  const sentStats = campaigns.flatMap((c) => (c.stats ? [c.stats] : []));
  const sum = (k: 'bookings' | 'revenue' | 'delivered' | 'opened' | 'unsubscribed') => sentStats.reduce((a, st) => a + st[k], 0);
  const totals = { bookings: sum('bookings'), revenue: sum('revenue'), delivered: sum('delivered'), opened: sum('opened'), unsubscribed: sum('unsubscribed') };
  const best = campaigns.filter((c) => (c.stats?.revenue ?? 0) > 0).sort((a, b) => b.stats!.revenue - a.stats!.revenue)[0];
  const next = campaigns.filter((c) => c.status === 'scheduled' && c.scheduledAt).sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))[0];

  const [picking, setPicking] = useState(false);
  const start = () => setPicking(true);
  async function begin(play: string | null) {
    const draft = await create.mutateAsync(play ? { play } : { content: { version: 1, preview: '', blocks: [] } });
    await navigate({ to: '/$tenant/campaigns/$campaign', params: { tenant: tenant.id, campaign: draft.id } });
  }

  return (
    <>
      <PageTitle
        eyebrow="Campaigns"
        title="One email, the right clients"
        subtitle={
          totals.revenue > 0 ? (
            <>
              Campaigns booked <strong className="font-semibold text-ink">{money(totals.revenue)}</strong> in the last 90 days.
              {next && <> The next one goes out {when(next.scheduledAt!)}.</>}
            </>
          ) : (
            'Write an email once and send it to the clients it suits.'
          )
        }
        actions={
          <Button variant="accent" onClick={start} disabled={create.isPending}>
            <Plus size={15} /> Create campaign
          </Button>
        }
      />
      {create.isError && <Notice tone="bad">{create.error.message}</Notice>}
      {picking && <PlayPicker busy={create.isPending} onPick={begin} onClose={() => setPicking(false)} />}

      {campaigns.length === 0 ? (
        <Card className="flex max-w-2xl flex-col items-start gap-4 px-6 py-6">
          <h2 className="display m-0 text-[22px]">Your first campaign</h2>
          <p className="m-0 text-[15px] leading-relaxed text-muted">
            Start from a ready-made email, such as this week’s free times or a new treatment, change the words, pick who gets it, and send a test to yourself before it goes.
          </p>
          <Button onClick={start} disabled={create.isPending}>
            Start writing
          </Button>
        </Card>
      ) : (
        <>
          {totals.delivered > 0 && (
            <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
              <Figure label="Booked from campaigns" value={nf.format(totals.bookings)} sub="within five days of an email" />
              <Figure label="Value" value={money(totals.revenue)} sub={`${money(Math.round(totals.revenue / Math.max(1, totals.delivered)))} per email delivered`} />
              <Figure label="Opened" value={rate(totals.opened, totals.delivered)} sub={`of ${nf.format(totals.delivered)} delivered`} />
              <Figure label="Unsubscribed" value={rate(totals.unsubscribed, totals.delivered)} sub={totals.unsubscribed / totals.delivered < 0.01 ? 'healthy, under 1%' : 'above 1%, worth a look'} />
            </div>
          )}
          <Segmented<Filter>
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All (${campaigns.length})` },
              { value: 'draft', label: `Drafts (${count('draft')})` },
              { value: 'scheduled', label: `Scheduled (${count('scheduled')})` },
              { value: 'sent', label: `Sent (${count('sent')})` },
            ]}
          />
          <Card className="overflow-x-auto">
            {shown.length === 0 ? (
              <p className="m-0 px-5 py-8 text-center text-[13px] text-muted">Nothing here.</p>
            ) : (
              <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                <thead>
                  <tr className="text-xs text-muted">
                    <th className="px-5 py-3 font-medium">Campaign</th>
                    <th className="px-3 py-3 font-medium">Status</th>
                    <th className="px-3 py-3 text-right font-medium">Recipients</th>
                    <th className="px-3 py-3 text-right font-medium">Opened</th>
                    <th className="px-3 py-3 text-right font-medium">Clicked</th>
                    <th className="px-5 py-3 text-right font-medium">Booked</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => (
                    <Row key={c.id} campaign={c} audience={segmentName(c.segmentId)} best={c.id === best?.id} />
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card className="flex flex-col gap-1 px-4 py-3.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="display text-[30px] leading-none">{value}</span>
      <span className="text-xs text-muted">{sub}</span>
    </Card>
  );
}

function Row({ campaign: c, audience, best }: { campaign: Campaign; audience: string; best: boolean }) {
  const tenant = useTenant();
  const stats = c.stats;
  const sub =
    c.status === 'scheduled' && c.scheduledAt
      ? `Goes out ${when(c.scheduledAt)}`
      : c.sentAt
        ? `Sent ${when(c.sentAt)}`
        : `Edited ${when(c.updatedAt)}`;
  return (
    <tr className={cx('border-t border-rule transition hover:bg-soft/50', best && 'bg-[linear-gradient(90deg,var(--tint),transparent_60%)]')}>
      <td className="px-5 py-3.5">
        <Link to="/$tenant/campaigns/$campaign" params={{ tenant: tenant.id, campaign: c.id }} className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2 font-medium text-ink">
            {c.name}
            {best && <span className="rounded-full bg-tint px-2 py-0.5 text-[11px] font-semibold text-accent-ink">Best lately</span>}
          </span>
          <span className="text-xs text-muted">
            {sub} · {audience}
          </span>
        </Link>
      </td>
      <td className="px-3 py-3.5">
        <CampaignBadge status={c.status} />
      </td>
      <td className="px-3 py-3.5 text-right tabular-nums">{c.recipients === null ? '–' : nf.format(c.recipients)}</td>
      <td className="px-3 py-3.5 text-right tabular-nums">{stats ? rate(stats.opened, stats.delivered) : '–'}</td>
      <td className="px-3 py-3.5 text-right tabular-nums">{stats ? rate(stats.clicked, stats.delivered) : '–'}</td>
      <td className="px-5 py-3.5 text-right tabular-nums">
        {stats ? (
          <span className="flex flex-col items-end">
            <span className={cx(stats.bookings > 0 && 'font-semibold text-ink')}>{stats.bookings}</span>
            {stats.revenue > 0 && <span className="text-xs text-muted">{money(stats.revenue)}</span>}
          </span>
        ) : (
          '–'
        )}
      </td>
    </tr>
  );
}

const GROUPS: { for: Play['for']; title: string }[] = [
  { for: 'any', title: 'For any business' },
  { for: 'salon', title: 'Salons, spas and clinics' },
  { for: 'studio', title: 'Creative studios' },
];

/** Choosing what to start from: a ready-made campaign, or a blank email. */
function PlayPicker({ busy, onPick, onClose }: { busy: boolean; onPick: (play: string | null) => void; onClose: () => void }) {
  const { data: plays = [] } = useQuery(playsQuery);
  return (
    <Sheet title="Start a campaign" onClose={onClose}>
      <p className="m-0 text-[13px] text-muted">Each one is ready to send once you fill in anything in [square brackets].</p>
      {GROUPS.map((group) => (
        <section key={group.for} className="flex flex-col gap-2">
          <h3 className="m-0 text-[13px] font-semibold">{group.title}</h3>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {plays
              .filter((p) => p.for === group.for)
              .map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onPick(p.id)}
                    className="flex w-full cursor-pointer flex-col items-start gap-1 rounded-xl border-0 bg-transparent px-4 py-3 text-left font-[inherit] shadow-ring hover:bg-soft focus-visible:outline-2 focus-visible:outline-ink disabled:cursor-wait"
                  >
                    <span className="text-[14px] font-semibold text-ink">{p.name}</span>
                    <span className="text-[13px] text-muted">{p.goal}</span>
                    {p.diary && (
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                        <CalendarClock size={12} aria-hidden /> Shows your free times
                      </span>
                    )}
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
      <Button variant="secondary" className="self-start" disabled={busy} onClick={() => onPick(null)}>
        Start from a blank email
      </Button>
    </Sheet>
  );
}
