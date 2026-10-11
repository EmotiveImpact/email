import { Card, PageTitle } from '../components/ui.tsx';

const AREAS = {
  campaigns: {
    title: 'Campaigns',
    lead: 'Write a newsletter once, see which days are quiet, and send it to the clients most likely to book.',
    points: ['Drag-and-drop editor that looks right in every inbox', 'Calendar shaded by how full your diary is', 'Bookings and revenue counted for each send'],
  },
  flows: {
    title: 'Flows',
    lead: 'Emails that send themselves when something happens in your diary.',
    points: ['Fill empty slots: offer quiet days to the clients who usually book them', 'Due for a visit: nudge clients who have passed their usual gap', 'Welcome: turn a first visit into a second'],
  },
} as const;

export function Soon({ area }: { area: keyof typeof AREAS }) {
  const a = AREAS[area];
  return (
    <>
      <PageTitle title={a.title} subtitle="Being built next. Sending already works underneath it." />
      <Card className="flex max-w-2xl flex-col gap-4 px-6 py-6">
        <p className="m-0 text-[15px] leading-relaxed">{a.lead}</p>
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {a.points.map((p) => (
            <li key={p} className="flex gap-3 text-sm text-muted">
              <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-accent" />
              {p}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
