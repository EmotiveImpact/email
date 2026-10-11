import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, CalendarClock, Check, Info, Send, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  audienceQuery,
  campaignQuery,
  meQuery,
  segmentsQuery,
  useDeleteCampaign,
  useSaveCampaign,
  useScheduleCampaign,
  useSendTest,
  useUnscheduleCampaign,
  type CampaignDetail,
  type CampaignPatch,
  type EmailDoc,
} from '../api.ts';
import { Booked, BlocksCard, Field, Preview, Sheet, Stat, TagField, control, fill } from '../components/email-editor.tsx';
import { useTenant } from '../components/Shell.tsx';
import { Button, Card, Notice, Segmented, cx } from '../components/ui.tsx';
import { inStudio, tellHost } from '../studio.ts';
import { CampaignBadge, rate, when } from './Campaigns.tsx';

const nf = new Intl.NumberFormat('en-GB');

/** A campaign: the editor while it is a draft, its results once it has gone. */
export function CampaignPage() {
  const tenant = useTenant();
  const { campaign: id } = useParams({ from: '/$tenant/campaigns/$campaign' });
  const { data: campaign } = useSuspenseQuery(campaignQuery(tenant.id, id));
  return campaign.status === 'draft' ? <Editor key={campaign.id} campaign={campaign} /> : <Results campaign={campaign} />;
}

function Back() {
  const tenant = useTenant();
  return (
    <Link to="/$tenant/campaigns" params={{ tenant: tenant.id }} className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-ink">
      <ArrowLeft size={14} /> Campaigns
    </Link>
  );
}

// ---------------------------------------------------------------- editor

type Draft = Required<CampaignPatch>;

function Editor({ campaign }: { campaign: CampaignDetail }) {
  const tenant = useTenant();
  const [draft, setDraft] = useState<Draft>({ name: campaign.name, subject: campaign.subject, segmentId: campaign.segmentId, content: campaign.content });
  const [panel, setPanel] = useState<'review' | 'test' | null>(null);
  const save = useSaveCampaign(tenant.id, campaign.id);
  const remove = useDeleteCampaign(tenant.id);
  const navigate = useNavigate();

  // Save a moment after the last change; there is no save button to forget.
  const draftKey = JSON.stringify(draft);
  const [savedKey, setSavedKey] = useState(draftKey);
  useEffect(() => {
    if (draftKey === savedKey) return;
    const t = setTimeout(() => {
      save.mutate(JSON.parse(draftKey) as Draft, { onSuccess: () => setSavedKey(draftKey) });
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, savedKey]);
  const dirty = draftKey !== savedKey;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setContent = (content: Partial<EmailDoc>) => setDraft((d) => ({ ...d, content: { ...d.content, ...content } }));

  const problems = dirty ? null : save.data?.problems ?? campaign.problems;

  return (
    <>
      <Back />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
          <label className="flex flex-col">
            <span className="sr-only">Campaign name</span>
            <input
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Name this campaign"
              className="display w-full border-0 border-b border-transparent bg-transparent p-0 text-[34px] leading-tight outline-none placeholder:text-faint focus:border-rule-strong"
            />
          </label>
          <span className="flex items-center gap-2 text-[13px] text-muted">
            <CampaignBadge status="draft" />
            {save.isError ? <span className="text-bad">Not saved: {save.error.message}</span> : dirty || save.isPending ? 'Saving…' : 'All changes saved'}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            aria-label="Delete draft"
            onClick={async () => {
              await remove.mutateAsync(campaign.id);
              await navigate({ to: '/$tenant/campaigns', params: { tenant: tenant.id } });
            }}
          >
            <Trash2 size={14} />
          </Button>
          <Button variant="secondary" onClick={() => setPanel('test')}>
            <Send size={14} /> Send a test
          </Button>
          <Button variant="accent" onClick={() => setPanel('review')}>
            Review and send
          </Button>
        </div>
      </div>

      {campaign.problem && campaign.status === 'draft' && (
        <Notice tone="bad">
          {campaign.problem}{' '}
          <Link to="/$tenant/billing" params={{ tenant: tenant.id }} className="font-semibold text-inherit underline">
            See plans
          </Link>
        </Notice>
      )}

      <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="flex flex-col gap-4 px-5 py-5">
            <TagField label="Subject line" value={draft.subject} onChange={(subject) => set({ subject })} placeholder="What will make them open it?" />
            <TagField
              label="Preview text"
              hint="Shown after the subject in most inboxes."
              value={draft.content.preview}
              onChange={(preview) => setContent({ preview })}
              placeholder="A line that adds to the subject"
            />
            <AudiencePicker segmentId={draft.segmentId} onChange={(segmentId) => set({ segmentId })} />
          </Card>

          <BlocksCard blocks={draft.content.blocks} onChange={(blocks) => setContent({ blocks })} />
        </div>

        <Preview content={draft.content} subject={draft.subject} />
      </div>

      {panel === 'test' && <TestPanel campaignId={campaign.id} onClose={() => setPanel(null)} />}
      {panel === 'review' && (
        <ReviewPanel campaign={campaign} subject={draft.subject} problems={problems} saving={dirty || save.isPending} onClose={() => setPanel(null)} />
      )}
    </>
  );
}

function AudiencePicker({ segmentId, onChange }: { segmentId: string | null; onChange: (id: string | null) => void }) {
  const tenant = useTenant();
  const { data: segments = [] } = useQuery(segmentsQuery(tenant.id));
  const { data: audience } = useQuery({ ...audienceQuery(tenant.id, segmentId), placeholderData: (p) => p });
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">Who gets it</span>
      <select value={segmentId ?? ''} onChange={(e) => onChange(e.target.value || null)} className={control}>
        <option value="">Everyone who said yes to news</option>
        {segments.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {audience && <AudienceLine audience={audience} />}
    </label>
  );
}

function AudienceLine({ audience }: { audience: { eligible: number; noConsent: number; suppressed: number } }) {
  const left = [
    audience.noConsent > 0 && `${nf.format(audience.noConsent)} without consent`,
    audience.suppressed > 0 && `${nf.format(audience.suppressed)} unsubscribed or bouncing`,
  ].filter(Boolean);
  return (
    <span className="text-xs text-muted">
      <span className="font-semibold text-ink">{nf.format(audience.eligible)} people</span> will get it
      {left.length > 0 && <>; leaves out {left.join(' and ')}</>}.
    </span>
  );
}

// ---------------------------------------------------------------- panels

function TestPanel({ campaignId, onClose }: { campaignId: string; onClose: () => void }) {
  const tenant = useTenant();
  const { data: me } = useQuery(meQuery);
  const [to, setTo] = useState(me?.user.email ?? '');
  const test = useSendTest(tenant.id, campaignId);
  return (
    <Sheet title="Send a test" onClose={onClose}>
      <p className="m-0 text-sm leading-relaxed text-muted">
        A copy goes to one address with “[Test]” before the subject, filled in as if it were for Ama Mensah. It does not count in the results.
      </p>
      <Field label="Send to">
        <input type="email" value={to} onChange={(e) => setTo(e.target.value)} className={control} />
      </Field>
      {test.isSuccess && (
        <Notice>
          <span className="inline-flex items-center gap-2">
            <Check size={14} /> On its way to {test.data.to}.
          </span>
        </Notice>
      )}
      {test.isError && <Notice tone="bad">{test.error.message}</Notice>}
      <Button onClick={() => test.mutate(to)} disabled={!to || test.isPending} className="self-start">
        <Send size={14} /> {test.isPending ? 'Sending…' : 'Send test'}
      </Button>
    </Sheet>
  );
}

function ReviewPanel({
  campaign,
  subject,
  problems,
  saving,
  onClose,
}: {
  campaign: CampaignDetail;
  subject: string;
  problems: string[] | null;
  saving: boolean;
  onClose: () => void;
}) {
  const tenant = useTenant();
  const { data: fresh } = useQuery(campaignQuery(tenant.id, campaign.id));
  const current = fresh ?? campaign;
  const list = problems ?? current.problems;
  const advice = saving ? [] : current.warnings ?? [];
  const audience = current.audience;
  const [mode, setMode] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState(() => localInput(new Date(Date.now() + 86_400_000)));
  const schedule = useScheduleCampaign(tenant.id, campaign.id);
  const ready = !saving && list.length === 0;

  return (
    <Sheet title="Review and send" onClose={onClose}>
      <dl className="m-0 grid grid-cols-[64px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-muted">From</dt>
        <dd className="m-0 flex flex-col">
          <span className="truncate">{current.sender.from}</span>
          {!current.sender.own && !inStudio() && (
            <Link to="/$tenant/settings/domain" params={{ tenant: tenant.id }} className="text-xs text-muted underline hover:text-ink">
              Send from your own domain
            </Link>
          )}
        </dd>
        <dt className="text-muted">Subject</dt>
        <dd className="m-0">{fill(subject, tenant.name) || '–'}</dd>
      </dl>
      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-[13px] font-semibold">Before it goes</h3>
        {saving ? (
          <p className="m-0 text-[13px] text-muted">Saving your last changes…</p>
        ) : list.length === 0 ? (
          <Check14 text="Subject, content and links all look right." />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {list.map((p) => (
              <li key={p} className="flex items-start gap-2 text-[13px] text-warn">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden /> {p}
              </li>
            ))}
          </ul>
        )}
      </section>

      {advice.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-[13px] font-semibold">Worth a look before it lands in inboxes</h3>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {advice.map((p) => (
              <li key={p} className="flex items-start gap-2 text-[13px] text-muted">
                <Info size={14} className="mt-0.5 shrink-0" aria-hidden /> {p}
              </li>
            ))}
          </ul>
        </section>
      )}

      {audience && (
        <section className="flex flex-col gap-1.5 rounded-xl bg-soft px-4 py-3.5">
          <span className="display text-[30px] leading-none">{nf.format(audience.eligible)}</span>
          <span className="text-[13px] text-muted">
            people will get it. We leave out anyone who has not said yes to news ({nf.format(audience.noConsent)}) and anyone who unsubscribed or whose
            address bounced ({nf.format(audience.suppressed)}).
          </span>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h3 className="m-0 text-[13px] font-semibold">When</h3>
        <Segmented
          label="When"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'now', label: 'Send now' },
            { value: 'later', label: 'Schedule' },
          ]}
        />
        {mode === 'later' && (
          <Field label="Send at" hint="Your local time. Tuesday to Thursday mornings tend to do well for appointment businesses.">
            <input type="datetime-local" value={at} min={localInput(new Date())} onChange={(e) => setAt(e.target.value)} className={control} />
          </Field>
        )}
      </section>

      {schedule.isError && <Notice tone="bad">{schedule.error.message}</Notice>}
      <Button
        variant="accent"
        className="self-start"
        disabled={!ready || schedule.isPending || (mode === 'later' && !at)}
        onClick={() =>
          schedule.mutate(mode === 'later' ? new Date(at).toISOString() : null, {
            onSuccess: (sent) => tellHost({ type: 'campaign.scheduled', campaignId: sent.id, sendAt: sent.scheduledAt ?? new Date().toISOString() }),
          })
        }
      >
        {mode === 'now' ? <Send size={14} /> : <CalendarClock size={14} />}
        {schedule.isPending
          ? 'Working…'
          : mode === 'now'
            ? `Send to ${nf.format(audience?.eligible ?? 0)} people`
            : `Schedule for ${when(new Date(at).toISOString())}`}
      </Button>
    </Sheet>
  );
}

const Check14 = ({ text }: { text: string }) => (
  <span className="flex items-center gap-2 text-[13px] text-good">
    <Check size={14} /> {text}
  </span>
);

/** A Date as the value a datetime-local input expects, in local time. */
function localInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------- results

function Results({ campaign }: { campaign: CampaignDetail }) {
  const tenant = useTenant();
  const { data: segments = [] } = useQuery(segmentsQuery(tenant.id));
  const unschedule = useUnscheduleCampaign(tenant.id, campaign.id);
  const segment = campaign.segmentId ? (segments.find((s) => s.id === campaign.segmentId)?.name ?? 'a deleted segment') : 'everyone who said yes';
  const s = campaign.stats;
  const handed = s ? s.total - s.pending : 0;

  return (
    <>
      <Back />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="display m-0 text-[34px] leading-[1.05]">{campaign.name}</h1>
          <span className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <CampaignBadge status={campaign.status} />
            {campaign.status === 'scheduled' && campaign.scheduledAt && <>Goes out {when(campaign.scheduledAt)} to {segment}</>}
            {campaign.sentAt && <>Sent {when(campaign.sentAt)} to {segment}</>}
            {campaign.status === 'sending' && <>Going out to {segment}</>}
          </span>
        </div>
        {campaign.status === 'scheduled' && (
          <Button variant="secondary" onClick={() => unschedule.mutate()} disabled={unschedule.isPending}>
            Unschedule and edit
          </Button>
        )}
      </div>
      {unschedule.isError && <Notice tone="bad">{unschedule.error.message}</Notice>}

      <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="flex flex-col gap-4">
          {s ? (
            <>
              {s.pending > 0 && (
                <Notice>
                  {nf.format(handed)} of {nf.format(s.total)} handed to Amazon SES. We pace sends so your address keeps a good name with inboxes.
                </Notice>
              )}
              <Booked bookings={s.bookings} revenue={s.revenue} />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Delivered" value={nf.format(s.delivered)} sub={`of ${nf.format(s.total)} sent`} />
                <Stat label="Opened" value={rate(s.opened, s.delivered)} sub={`${nf.format(s.opened)} people`} />
                <Stat label="Clicked" value={rate(s.clicked, s.delivered)} sub={`${nf.format(s.clicked)} people`} />
                <Stat label="Unsubscribed" value={nf.format(s.unsubscribed)} sub={rate(s.unsubscribed, s.delivered)} />
                <Stat label="Bounced" value={nf.format(s.bounced)} sub={rate(s.bounced, s.total)} tone={s.total && s.bounced / s.total > 0.05 ? 'bad' : undefined} />
                <Stat label="Marked as spam" value={nf.format(s.complained)} sub={rate(s.complained, s.total)} tone={s.complained > 0 ? 'bad' : undefined} />
              </div>
              {((campaign.skippedNoConsent ?? 0) > 0 || (campaign.skippedSuppressed ?? 0) > 0) && (
                <Card className="px-5 py-4 text-[13px] leading-relaxed text-muted">
                  Left out to protect your sending: {nf.format(campaign.skippedNoConsent ?? 0)} without consent for news, and{' '}
                  {nf.format(campaign.skippedSuppressed ?? 0)} who unsubscribed or whose address bounced before.
                </Card>
              )}
              <p className="m-0 text-xs text-faint">Opens are a rough guide: some inboxes open every email to check it, and others block the tracking.</p>
            </>
          ) : (
            <Upcoming segmentId={campaign.segmentId} />
          )}
        </div>
        <Preview content={campaign.content} subject={campaign.subject} />
      </div>
    </>
  );
}

/** Before it goes: who it will reach today. The list is checked again when it sends. */
function Upcoming({ segmentId }: { segmentId: string | null }) {
  const tenant = useTenant();
  const { data: audience } = useQuery(audienceQuery(tenant.id, segmentId));
  return (
    <Card className="flex flex-col gap-1.5 px-5 py-5">
      <span className="text-xs text-muted">If it went now</span>
      <span className="display text-[30px] leading-none">{audience ? nf.format(audience.eligible) : '…'}</span>
      <span className="text-[13px] leading-relaxed text-muted">
        people would get it. The list is worked out again at send time, so anyone who books, unsubscribes or says yes before then is counted correctly.
        Results appear here once it starts going out.
      </span>
    </Card>
  );
}

