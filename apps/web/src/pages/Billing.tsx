import { useSuspenseQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { billingQuery, openBillingPortal, useChoosePlan, type Billing as BillingData, type Plan } from '../api.ts';
import { useTenant } from '../components/Shell.tsx';
import { Button, Card, CardTitle, Notice, PageTitle, cx } from '../components/ui.tsx';

const nf = new Intl.NumberFormat('en-GB');
const pounds = (pence: number) => (pence === 0 ? '£0' : `£${(pence / 100).toFixed(pence % 100 ? 2 : 0)}`);
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

export function Billing() {
  const tenant = useTenant();
  const { data } = useSuspenseQuery(billingQuery(tenant.id));
  const choose = useChoosePlan(tenant.id);
  const current = data.plans.find((p) => p.id === data.plan)!;
  const paid = new URLSearchParams(window.location.search).has('paid');

  if (data.billed === 'app') {
    return (
      <>
        <PageTitle title="Billing" subtitle={`${tenant.name} is paid for through ${tenant.app ?? 'the app it belongs to'}, so there is nothing to pay here.`} />
        <Usage data={data} plan={null} />
      </>
    );
  }

  return (
    <>
      <PageTitle
        eyebrow={`${current.name} plan${data.cancelAtPeriodEnd ? ` · ends ${day(data.periodEnd)}` : ''}`}
        title="Billing"
        subtitle="Plans are priced by the people who said yes to your news. Booking confirmations and reminders are always free."
        actions={
          data.payments === 'live' && data.plan !== 'free' ? (
            <Button variant="secondary" onClick={() => openBillingPortal(tenant.id)}>
              Invoices and card
            </Button>
          ) : undefined
        }
      />
      {paid && <Notice>Thank you. Your plan is being switched on; it shows here in a moment.</Notice>}
      {data.payments === 'sample' && <Notice>Payments are in test mode: choosing a plan switches it straight away, and nobody is charged.</Notice>}
      {data.payments === 'off' && <Notice>Payments are not switched on yet. Get in touch and we will set up your plan.</Notice>}

      <Usage data={data} plan={current} />

      <div className="grid grid-cols-1 gap-3 @[720px]:grid-cols-3 @[1100px]:grid-cols-5">
        {data.plans.map((plan) => {
          const isCurrent = plan.id === data.plan;
          const tooSmall = plan.contacts < data.usage.contacts;
          return (
            <Card key={plan.id} className={cx('flex flex-col gap-3 px-5 py-5', isCurrent && 'outline-2 outline-accent')}>
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-semibold">{plan.name}</span>
                {isCurrent && <span className="rounded-full bg-tint px-2 py-0.5 text-[11px] font-medium text-accent-ink">Current</span>}
              </div>
              <div className="flex items-baseline gap-1">
                <span className="display text-[34px] leading-none">{pounds(plan.price)}</span>
                <span className="text-xs text-muted">a month</span>
              </div>
              <p className="m-0 min-h-[36px] text-xs leading-relaxed text-muted">{plan.pitch}</p>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
                <li className="flex gap-2">
                  <Check size={14} className="mt-0.5 shrink-0 text-accent-ink" /> {nf.format(plan.contacts)} people
                </li>
                <li className="flex gap-2">
                  <Check size={14} className="mt-0.5 shrink-0 text-accent-ink" /> {nf.format(plan.emails)} emails a month
                </li>
                <li className="flex gap-2">
                  <Check size={14} className="mt-0.5 shrink-0 text-accent-ink" /> Every flow and feature
                </li>
              </ul>
              <span className="grow" />
              <Button
                variant={isCurrent ? 'secondary' : plan.price > current.price ? 'accent' : 'secondary'}
                disabled={isCurrent || choose.isPending || data.payments === 'off' || (tooSmall && plan.id === 'free')}
                onClick={() => choose.mutate(plan.id)}
                title={tooSmall ? `You have ${nf.format(data.usage.contacts)} people; this plan covers ${nf.format(plan.contacts)}.` : undefined}
              >
                {isCurrent ? 'Your plan' : choose.isPending && choose.variables === plan.id ? 'One moment…' : plan.price > current.price ? `Choose ${plan.name}` : `Switch to ${plan.name}`}
              </Button>
            </Card>
          );
        })}
      </div>
      {choose.isError && <Notice tone="bad">{choose.error.message}</Notice>}
      <p className="m-0 px-1 text-xs text-muted">Change or cancel at any time; a cancelled plan runs to the end of the month you paid for.</p>
    </>
  );
}

function Usage({ data, plan }: { data: BillingData; plan: Plan | null }) {
  return (
    <Card className="flex flex-col gap-4 px-5 py-5">
      <CardTitle aside={<span className="text-xs text-muted">Since {day(data.periodStart)} · resets {day(data.periodEnd)}</span>}>This month</CardTitle>
      <div className="grid gap-5 @[720px]:grid-cols-2">
        <Meter label="People who said yes to news" used={data.usage.contacts} limit={plan?.contacts ?? null} />
        <Meter label="News and flow emails sent" used={data.usage.emails} limit={plan?.emails ?? null} />
      </div>
    </Card>
  );
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const share = limit ? Math.min(1, used / limit) : 0;
  const tone = share >= 1 ? 'bg-[var(--bad)]' : share >= 0.8 ? 'bg-[var(--warn)]' : 'bg-accent';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-muted">{label}</span>
        <span className="text-[13px]">
          <strong className="tabular-nums">{nf.format(used)}</strong>
          {limit !== null && <span className="text-muted"> of {nf.format(limit)}</span>}
        </span>
      </div>
      {limit !== null && (
        <div className="h-2 overflow-hidden rounded-full bg-well" role="meter" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit}>
          <div className={cx('h-full rounded-full', tone)} style={{ width: `${Math.max(used ? 2 : 0, share * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
