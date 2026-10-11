/**
 * Home's first card for a new business: the steps from signing up to a first booking from email,
 * and a nudge when the plan is nearly used up.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Check, X } from 'lucide-react';
import { useState } from 'react';
import { billingQuery, gettingStartedQuery, type Step } from '../api.ts';
import { readFlag, writeFlag } from './Shell.tsx';
import { Card, Notice, cx } from './ui.tsx';

const WHERE: Record<Step['id'], { to: string; search?: Record<string, string>; hint: string }> = {
  details: { to: '/$tenant/settings/appearance', hint: 'Every email needs them' },
  clients: { to: '/$tenant/audience', search: { import: 'clients' }, hint: 'From a spreadsheet' },
  diary: { to: '/$tenant/audience', search: { import: 'visits' }, hint: 'So flows know who is due' },
  domain: { to: '/$tenant/settings/domain', hint: 'Lands in inboxes, not spam' },
  flow: { to: '/$tenant/flows', hint: 'Rebooking works on its own' },
  email: { to: '/$tenant/campaigns', hint: 'News, an offer or free times' },
};

export function GettingStarted({ tenant }: { tenant: string }) {
  const { data } = useQuery(gettingStartedQuery(tenant));
  const key = `setup-hidden:${tenant}`;
  const [hidden, setHidden] = useState(() => readFlag(key, false));
  if (!data || hidden || data.done === data.total) return null;
  const next = data.steps.find((s) => !s.done);
  return (
    <Card className="flex flex-col gap-4 px-5 py-5 lg:col-span-12">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="display m-0 text-[22px]">Get set up</h2>
          <span className="text-[13px] text-muted">
            {data.done} of {data.total} done. Each step brings your first booking from email closer.
          </span>
        </div>
        <button
          type="button"
          aria-label="Hide for now"
          title="Hide for now"
          onClick={() => (writeFlag(key, true), setHidden(true))}
          className="grid size-8 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-muted hover:bg-soft"
        >
          <X size={16} />
        </button>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-well">
        <div className="h-full rounded-full bg-accent" style={{ width: `${(data.done / data.total) * 100}%` }} />
      </div>
      <ol className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2 xl:grid-cols-3">
        {data.steps.map((step) => {
          const where = WHERE[step.id];
          return (
            <li key={step.id}>
              <Link
                to={where.to}
                params={{ tenant }}
                search={where.search as never}
                className={cx(
                  'group flex items-center gap-3 rounded-[12px] px-3.5 py-3 no-underline transition',
                  step.done ? 'text-muted' : 'text-ink shadow-ring hover:bg-soft',
                  step === next && 'bg-tint shadow-none',
                )}
              >
                <span className={cx('grid size-6 shrink-0 place-items-center rounded-full', step.done ? 'bg-good-bg text-good' : 'border-[1.5px] border-rule-strong')}>
                  {step.done && <Check size={13} />}
                </span>
                <span className="flex grow flex-col">
                  <span className={cx('text-[13.5px]', !step.done && 'font-medium', step.done && 'line-through decoration-rule-strong')}>{step.title}</span>
                  {!step.done && <span className="text-xs text-muted">{where.hint}</span>}
                </span>
                {!step.done && <ArrowRight size={14} className="text-faint transition group-hover:translate-x-0.5 group-hover:text-ink" />}
              </Link>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/** Shown once a business has used most of its plan, so a campaign is never stopped by surprise. */
export function PlanNotice({ tenant }: { tenant: string }) {
  const { data } = useQuery(billingQuery(tenant));
  if (!data || data.billed !== 'business') return null;
  const plan = data.plans.find((p) => p.id === data.plan)!;
  const emails = data.usage.emails / plan.emails;
  const over = data.usage.contacts > plan.contacts;
  if (!over && emails < 0.8) return null;
  return (
    <div className="lg:col-span-12">
      <Notice tone={over || emails >= 1 ? 'bad' : 'neutral'}>
        {over
          ? `${data.usage.contacts.toLocaleString('en-GB')} people said yes to your news, more than the ${plan.contacts.toLocaleString('en-GB')} on ${plan.name}. Sending is paused until you choose a bigger plan.`
          : emails >= 1
            ? `This month's ${plan.emails.toLocaleString('en-GB')} emails on ${plan.name} are used. Flows wait until ${new Date(data.periodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}, or you can move up a plan.`
            : `You have used ${Math.round(emails * 100)}% of this month's emails on ${plan.name}.`}{' '}
        <Link to="/$tenant/billing" params={{ tenant }} className="font-semibold text-inherit underline">
          See plans
        </Link>
      </Notice>
    </div>
  );
}
