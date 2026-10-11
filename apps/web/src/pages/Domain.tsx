import { useSuspenseQuery } from '@tanstack/react-query';
import { Check, Copy, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { sendingQuery, useAddDomain, useCheckDomain, useRemoveDomain, useResumeSending, type DnsRecord, type Domain as DomainRow } from '../api.ts';
import { useTenant } from '../components/Shell.tsx';
import { Button, Card, CardTitle, Notice, PageTitle, cx } from '../components/ui.tsx';

const control =
  'h-9 rounded-[10px] border border-rule-strong bg-paper px-2.5 font-[inherit] text-[13px] text-ink outline-none focus:border-ink';
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const pct = (n: number) => `${(n * 100).toFixed(n < 0.01 ? 2 : 1)}%`;

export function Domain() {
  const tenant = useTenant();
  const { data } = useSuspenseQuery(sendingQuery(tenant.id));
  const resume = useResumeSending(tenant.id);
  const { sender, reputation, domains } = data;

  return (
    <>
      <PageTitle title="Sending domain" subtitle="Send from your own address, signed so inboxes trust it." />

      {tenant.status === 'paused' && (
        <Notice tone="bad">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              <strong>Sending is paused.</strong> {tenant.pausedReason ?? 'Sending was paused to protect your reputation.'} Emails are held, not lost. Clean the
              list (remove old and bought addresses) before you resume.
            </span>
            <Button variant="secondary" onClick={() => resume.mutate()} disabled={resume.isPending}>
              Resume sending
            </Button>
          </div>
        </Notice>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card className="flex flex-col gap-3 px-5 py-5">
          <CardTitle aside={sender.own ? 'Your own domain' : 'Platform address for now'}>Who your email comes from</CardTitle>
          <dl className="m-0 grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted">From</dt>
            <dd className="m-0 font-medium">{sender.from}</dd>
            <dt className="text-muted">Replies go to</dt>
            <dd className="m-0">{sender.replyTo ?? sender.from}</dd>
          </dl>
          {!sender.own && (
            <p className="m-0 text-[13px] leading-relaxed text-muted">
              Until your domain is verified, email goes out from our address with your business name on it, and replies still come to you. Your own domain
              looks more trustworthy and keeps your reputation separate.
            </p>
          )}
        </Card>

        <Card className="flex flex-col gap-3 px-5 py-5">
          <CardTitle aside="Last 7 days">Sending health</CardTitle>
          <div className="grid grid-cols-3 gap-3">
            <Health label="Sent" value={String(reputation.sent)} />
            <Health label="Bounced" value={pct(reputation.bounceRate)} bad={reputation.bounceRate > 0.02} />
            <Health label="Spam reports" value={pct(reputation.complaintRate)} bad={reputation.complaintRate > 0.001} />
          </div>
          <p className="m-0 text-xs leading-relaxed text-muted">
            We pause sending at 4% bounces or 0.2% spam reports over the week, before inbox providers start to distrust you.
          </p>
        </Card>
      </div>

      {domains.length === 0 ? <AddDomain /> : domains.map((d) => <DomainCard key={d.id} domain={d} />)}
    </>
  );
}

function Health({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted">{label}</span>
      <span className={cx('display text-[24px] leading-none', bad && 'text-bad')}>{value}</span>
    </div>
  );
}

function AddDomain() {
  const tenant = useTenant();
  const add = useAddDomain(tenant.id);
  const [domain, setDomain] = useState(() => tenant.fromEmail?.split('@')[1] ?? '');
  const [localPart, setLocalPart] = useState(() => tenant.fromEmail?.split('@')[0] ?? 'hello');
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return (
    <Card className="flex flex-col gap-4 px-5 py-5">
      <CardTitle>Set up your domain</CardTitle>
      <p className="m-0 max-w-2xl text-sm leading-relaxed text-muted">
        Use the domain of your website. We give you three records to add where you bought it (GoDaddy, Squarespace, 123 Reg and so on). It takes about
        ten minutes, and nothing about your website or existing email changes.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Send from</span>
          <span className="flex items-center gap-1.5">
            <input value={localPart} onChange={(e) => setLocalPart(e.target.value)} className={cx(control, 'w-28')} aria-label="Address name" />
            <span className="text-muted">@</span>
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="lindenstudio.co.uk" className={cx(control, 'w-64')} aria-label="Domain" />
          </span>
        </label>
        <Button onClick={() => add.mutate({ domain: clean, localPart })} disabled={!clean || add.isPending}>
          {add.isPending ? 'Setting up…' : 'Set up domain'}
        </Button>
      </div>
      {add.isError && <Notice tone="bad">{add.error.message}</Notice>}
    </Card>
  );
}

const STATUS: Record<DomainRow['status'], { label: string; tone: string }> = {
  pending: { label: 'Waiting for DNS', tone: 'bg-warn-bg text-warn' },
  verified: { label: 'Verified', tone: 'bg-good-bg text-good' },
  failed: { label: 'Records not found', tone: 'bg-bad-bg text-bad' },
};

function DomainCard({ domain: d }: { domain: DomainRow }) {
  const tenant = useTenant();
  const check = useCheckDomain(tenant.id);
  const remove = useRemoveDomain(tenant.id);
  const status = STATUS[d.status];
  return (
    <Card className="flex flex-col gap-4 px-5 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="display m-0 text-[20px]">{d.domain}</h2>
          <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs font-medium', status.tone)}>
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {status.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{d.checkedAt ? `Checked ${when(d.checkedAt)}` : 'Not checked yet'}</span>
          <Button variant="secondary" onClick={() => check.mutate(d.id)} disabled={check.isPending}>
            <RefreshCw size={14} className={cx(check.isPending && 'animate-spin')} /> Check now
          </Button>
        </div>
      </div>

      {d.status === 'verified' ? (
        <p className="m-0 text-sm text-muted">
          Verified {d.verifiedAt ? when(d.verifiedAt) : ''}. Your emails are signed with DKIM for {d.domain}.
        </p>
      ) : (
        <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-sm leading-relaxed text-muted">
          <li>Sign in where you manage {d.domain}'s DNS (usually where you bought the domain).</li>
          <li>Add the three CNAME records below exactly as shown. Some providers add your domain to the name for you; if so, leave it off.</li>
          <li>Come back here. We check every few minutes for three days, and DNS changes can take up to a day to show.</li>
        </ol>
      )}

      <Records title="DKIM: proves your emails really come from you" records={d.records} done={d.status === 'verified'} />
      <Records
        title="DMARC: recommended, and expected by Gmail and Yahoo for newsletters"
        records={[d.dmarcRecord]}
        done={d.dmarc}
        note={d.dmarc ? 'Found.' : 'Not found yet. This starter record only asks for reports, so it cannot block your email.'}
      />

      {check.isError && <Notice tone="bad">{check.error.message}</Notice>}
      <button
        type="button"
        onClick={() => remove.mutate(d.id)}
        className="w-fit cursor-pointer border-0 bg-transparent p-0 text-xs text-muted underline hover:text-ink"
      >
        Remove this domain
      </button>
    </Card>
  );
}

function Records({ title, records, done, note }: { title: string; records: DnsRecord[]; done: boolean; note?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 flex items-center gap-2 text-[13px] font-semibold">
        {done ? <Check size={14} className="text-good" /> : <TriangleAlert size={14} className="text-warn" />}
        {title}
      </h3>
      <div className="overflow-x-auto rounded-xl border border-rule">
        <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="text-xs text-muted">
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.name} className="border-t border-rule">
                <td className="px-3 py-2 font-mono text-xs">{r.type}</td>
                <td className="px-3 py-2">
                  <Copyable text={r.name} />
                </td>
                <td className="px-3 py-2">
                  <Copyable text={r.value} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <span className="text-xs text-muted">{note}</span>}
    </section>
  );
}

function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-center gap-1.5">
      <code className="font-mono text-xs break-all">{text}</code>
      <button
        type="button"
        aria-label={`Copy ${text}`}
        onClick={async () => {
          await navigator.clipboard?.writeText(text).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-soft hover:text-ink"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  );
}
