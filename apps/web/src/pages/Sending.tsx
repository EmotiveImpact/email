import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { activityQuery, messagesQuery, SHOW, type Message, type Show } from '../api.ts';
import { useTenant } from '../components/Shell.tsx';
import { Card, PageTitle, Segmented, StatusBadge, reasonText } from '../components/ui.tsx';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Sending() {
  const tenant = useTenant();
  const [filter, setFilter] = useState<Show>('all');
  const { data: activity } = useSuspenseQuery(activityQuery(tenant.id));
  const { data: shown = [], isPending } = useQuery({ ...messagesQuery(tenant.id, filter), placeholderData: keepPreviousData });
  // Counts cover the last 30 days; the list shows the latest 100.
  const count = (f: Exclude<Show, 'all'>) => SHOW[f].reduce((sum, status) => sum + (activity.stats[status] ?? 0), 0);

  return (
    <>
      <PageTitle
        title="Sending"
        subtitle="Every email your apps sent for this business, and what happened to it."
        actions={
          <Segmented<Show>
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'arrived', label: `On their way (${count('arrived')})` },
              { value: 'held', label: `Held back (${count('held')})` },
              { value: 'problems', label: `Problems (${count('problems')})` },
            ]}
          />
        }
      />
      <Card className="overflow-hidden">
        {isPending ? (
          <p className="m-0 px-5 py-8 text-center text-[13px] text-muted">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="m-0 px-5 py-8 text-center text-[13px] text-muted">{filter === 'all' ? 'Nothing sent yet.' : 'Nothing here.'}</p>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th className="px-5 py-3 font-medium">Email</th>
                <th className="px-3 py-3 font-medium">To</th>
                <th className="px-3 py-3 font-medium">Kind</th>
                <th className="px-3 py-3 font-medium">What happened</th>
                <th className="px-5 py-3 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <Row key={m.id} message={m} />
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="m-0 text-xs leading-relaxed text-muted">
        Counts cover the last 30 days. Held back means we stopped the email before it left, so it could not hurt your sending reputation. Booking reminders and receipts still reach people who unsubscribed from news.
      </p>
    </>
  );
}

function Row({ message: m }: { message: Message }) {
  const reason = reasonText(m.reason);
  return (
    <tr className="border-t border-rule align-top">
      <td className="max-w-[320px] px-5 py-3">
        <div className="truncate font-medium">{m.subject}</div>
        <div className="truncate text-xs text-muted">From {m.from}</div>
      </td>
      <td className="max-w-[220px] truncate px-3 py-3">{m.to}</td>
      <td className="px-3 py-3 text-muted">{m.stream === 'marketing' ? 'News' : 'Service'}</td>
      <td className="px-3 py-3">
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={m.status} />
          {reason && <span className="text-xs text-muted">{reason}</span>}
        </div>
      </td>
      <td className="px-5 py-3 text-right whitespace-nowrap text-muted tabular-nums">{when(m.createdAt)}</td>
    </tr>
  );
}
