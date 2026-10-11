import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { campaignsQuery, segmentsQuery, useCreateCampaign, type Campaign, type CampaignStatus } from '../api.ts';
import { useTenant } from '../components/Shell.tsx';
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

  async function start() {
    const draft = await create.mutateAsync({});
    await navigate({ to: '/$tenant/campaigns/$campaign', params: { tenant: tenant.id, campaign: draft.id } });
  }

  return (
    <>
      <PageTitle
        title="Campaigns"
        subtitle="Write an email once and send it to the clients it suits."
        actions={
          <Button variant="accent" onClick={start} disabled={create.isPending}>
            <Plus size={15} /> Create campaign
          </Button>
        }
      />
      {create.isError && <Notice tone="bad">{create.error.message}</Notice>}

      {campaigns.length === 0 ? (
        <Card className="flex max-w-2xl flex-col items-start gap-4 px-6 py-6">
          <h2 className="display m-0 text-[22px]">Your first campaign</h2>
          <p className="m-0 text-[15px] leading-relaxed text-muted">
            Start from a ready-made email about open appointments, change the words, pick who gets it, and send a test to yourself before it goes.
          </p>
          <Button onClick={start} disabled={create.isPending}>
            Start writing
          </Button>
        </Card>
      ) : (
        <>
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
                    <th className="px-5 py-3 text-right font-medium">Clicked</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => (
                    <Row key={c.id} campaign={c} audience={segmentName(c.segmentId)} />
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

function Row({ campaign: c, audience }: { campaign: Campaign; audience: string }) {
  const tenant = useTenant();
  const stats = c.stats;
  const sub =
    c.status === 'scheduled' && c.scheduledAt
      ? `Goes out ${when(c.scheduledAt)}`
      : c.sentAt
        ? `Sent ${when(c.sentAt)}`
        : `Edited ${when(c.updatedAt)}`;
  return (
    <tr className="border-t border-rule transition hover:bg-soft/50">
      <td className="px-5 py-3.5">
        <Link to="/$tenant/campaigns/$campaign" params={{ tenant: tenant.id, campaign: c.id }} className="flex flex-col gap-0.5">
          <span className="font-medium text-ink">{c.name}</span>
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
      <td className="px-5 py-3.5 text-right tabular-nums">{stats ? rate(stats.clicked, stats.delivered) : '–'}</td>
    </tr>
  );
}
