import { MERGE_TAGS } from '@platform/content/merge';
import { newBlock } from '@platform/content/blocks';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  Braces,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronUp,
  Heading,
  Image,
  Minus,
  Monitor,
  MousePointerClick,
  MoveVertical,
  Send,
  Smartphone,
  Trash2,
  TriangleAlert,
  Type,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  audienceQuery,
  campaignQuery,
  meQuery,
  previewEmail,
  segmentsQuery,
  useDeleteCampaign,
  useSaveCampaign,
  useScheduleCampaign,
  useSendTest,
  useUnscheduleCampaign,
  type Block,
  type BlockType,
  type CampaignDetail,
  type CampaignPatch,
  type EmailDoc,
} from '../api.ts';
import { useTenant } from '../components/Shell.tsx';
import { Button, Card, Notice, Segmented, cx } from '../components/ui.tsx';
import { CampaignBadge, rate, when } from './Campaigns.tsx';

const nf = new Intl.NumberFormat('en-GB');
const control =
  'h-9 w-full rounded-[10px] border border-rule-strong bg-paper px-2.5 font-[inherit] text-[13px] text-ink outline-none focus:border-ink';

const BLOCKS: { type: BlockType; label: string; icon: ReactNode }[] = [
  { type: 'heading', label: 'Heading', icon: <Heading size={15} /> },
  { type: 'text', label: 'Text', icon: <Type size={15} /> },
  { type: 'button', label: 'Button', icon: <MousePointerClick size={15} /> },
  { type: 'image', label: 'Image', icon: <Image size={15} /> },
  { type: 'divider', label: 'Divider', icon: <Minus size={15} /> },
  { type: 'spacer', label: 'Space', icon: <MoveVertical size={15} /> },
];

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
  const [selected, setSelected] = useState<string | null>(campaign.content.blocks[0]?.id ?? null);
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
  const blocks = draft.content.blocks;
  const openBlock = blocks.some((b) => b.id === selected) ? selected : null;
  const setBlocks = (next: Block[]) => setContent({ blocks: next });

  function insert(type: BlockType) {
    const block = newBlock(type);
    const at = openBlock ? blocks.findIndex((b) => b.id === openBlock) + 1 : blocks.length;
    setBlocks([...blocks.slice(0, at), block, ...blocks.slice(at)]);
    setSelected(block.id);
  }
  function move(index: number, by: -1 | 1) {
    const next = [...blocks];
    const [b] = next.splice(index, 1);
    next.splice(index + by, 0, b!);
    setBlocks(next);
  }

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

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
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

          <Card className="flex flex-col gap-2 px-3 py-3">
            <div className="flex items-center justify-between px-2 pt-1 pb-1">
              <h2 className="display m-0 text-[17px]">Email</h2>
              <span className="text-xs text-muted">Click a block to change it</span>
            </div>
            {blocks.length === 0 && <p className="m-0 px-2 py-4 text-[13px] text-muted">The email is empty. Add a block below.</p>}
            <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
              {blocks.map((block, i) => (
                <BlockRow
                  key={block.id}
                  block={block}
                  open={openBlock === block.id}
                  onOpen={() => setSelected(openBlock === block.id ? null : block.id)}
                  onChange={(b) => setBlocks(blocks.map((x) => (x.id === b.id ? b : x)))}
                  onRemove={() => setBlocks(blocks.filter((x) => x.id !== block.id))}
                  onUp={i > 0 ? () => move(i, -1) : undefined}
                  onDown={i < blocks.length - 1 ? () => move(i, 1) : undefined}
                />
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-1.5 border-t border-rule px-2 pt-3 pb-1">
              <span className="mr-1 text-xs text-muted">{openBlock ? 'Add below the open block' : 'Add'}</span>
              {BLOCKS.map((b) => (
                <button
                  key={b.type}
                  type="button"
                  onClick={() => insert(b.type)}
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-rule-strong bg-paper px-3 text-[13px] text-ink hover:bg-soft"
                >
                  {b.icon} {b.label}
                </button>
              ))}
            </div>
          </Card>
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

/** A text input with a menu that drops in merge tags at the cursor. */
function TagField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState(false);
  function insert(tag: string) {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + tag + value.slice(end));
    setMenu(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + tag.length, start + tag.length);
    });
  }
  const Field = multiline ? 'textarea' : 'input';
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between text-[13px] font-medium">
        {label}
        <span className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              setMenu((m) => !m);
            }}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs font-normal text-muted hover:bg-soft hover:text-ink"
          >
            <Braces size={12} /> Personalise
          </button>
          {menu && (
            <span className="absolute top-full right-0 z-20 mt-1 flex w-48 flex-col rounded-xl border border-rule bg-paper p-1 shadow-lg">
              {MERGE_TAGS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    insert(t.key === 'first_name' ? '{{first_name|there}}' : `{{${t.key}}}`);
                  }}
                  className="cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] font-normal text-ink hover:bg-soft"
                >
                  {t.label}
                </button>
              ))}
            </span>
          )}
        </span>
      </span>
      <Field
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={multiline ? 6 : undefined}
        className={cx(control, multiline && 'h-auto py-2 leading-relaxed')}
      />
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
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

function summary(block: Block) {
  switch (block.type) {
    case 'heading':
      return block.text || 'Empty heading';
    case 'text':
      return block.text.replace(/\s+/g, ' ').slice(0, 80) || 'Empty text';
    case 'button':
      return block.label || 'Button';
    case 'image':
      return block.alt || (block.src ? 'Image' : 'No picture yet');
    case 'divider':
      return 'A line';
    case 'spacer':
      return { s: 'Small space', m: 'Space', l: 'Large space' }[block.size];
  }
}

function BlockRow({
  block,
  open,
  onOpen,
  onChange,
  onRemove,
  onUp,
  onDown,
}: {
  block: Block;
  open: boolean;
  onOpen: () => void;
  onChange: (b: Block) => void;
  onRemove: () => void;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const meta = BLOCKS.find((b) => b.type === block.type)!;
  const iconButton = 'grid size-7 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-soft hover:text-ink disabled:opacity-30';
  return (
    <li className={cx('rounded-xl border transition', open ? 'border-rule-strong bg-paper shadow-[0_1px_3px_#0000000F]' : 'border-transparent hover:bg-soft/60')}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 border-0 bg-transparent py-1 text-left font-[inherit]">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-soft text-muted">{meta.icon}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{summary(block)}</span>
        </button>
        <button type="button" aria-label="Move up" className={iconButton} disabled={!onUp} onClick={onUp}>
          <ChevronUp size={15} />
        </button>
        <button type="button" aria-label="Move down" className={iconButton} disabled={!onDown} onClick={onDown}>
          <ChevronDown size={15} />
        </button>
        <button type="button" aria-label="Remove block" className={iconButton} onClick={onRemove}>
          <Trash2 size={14} />
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-3 border-t border-rule px-3 pt-3 pb-3.5">
          <BlockSettings block={block} onChange={onChange} />
        </div>
      )}
    </li>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  );
}

function Align({ value, onChange }: { value: 'left' | 'center'; onChange: (v: 'left' | 'center') => void }) {
  return (
    <Segmented
      size="sm"
      label="Alignment"
      value={value}
      onChange={onChange}
      options={[
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Centre' },
      ]}
    />
  );
}

function BlockSettings({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  switch (block.type) {
    case 'heading':
      return (
        <>
          <TagField label="Heading" value={block.text} onChange={(text) => onChange({ ...block, text })} />
          <div className="flex flex-wrap gap-2">
            <Segmented
              size="sm"
              label="Size"
              value={String(block.level) as '1' | '2'}
              onChange={(v) => onChange({ ...block, level: v === '1' ? 1 : 2 })}
              options={[
                { value: '1', label: 'Large' },
                { value: '2', label: 'Small' },
              ]}
            />
            <Align value={block.align} onChange={(align) => onChange({ ...block, align })} />
          </div>
        </>
      );
    case 'text':
      return (
        <>
          <TagField label="Text" multiline value={block.text} onChange={(text) => onChange({ ...block, text })} />
          <span className="-mt-1.5 text-xs text-faint">
            **bold**, *italic* and [a link](https://…). A blank line starts a new paragraph.
          </span>
          <Align value={block.align} onChange={(align) => onChange({ ...block, align })} />
        </>
      );
    case 'button':
      return (
        <>
          <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
            <Field label="Label">
              <input value={block.label} onChange={(e) => onChange({ ...block, label: e.target.value })} className={control} />
            </Field>
            <Field label="Link" hint="Your booking page works best.">
              <input value={block.url} onChange={(e) => onChange({ ...block, url: e.target.value })} className={control} placeholder="https://" />
            </Field>
          </div>
          <Align value={block.align} onChange={(align) => onChange({ ...block, align })} />
        </>
      );
    case 'image':
      return (
        <>
          <Field label="Picture link" hint="Paste the address of a picture that is already online.">
            <input value={block.src} onChange={(e) => onChange({ ...block, src: e.target.value })} className={control} placeholder="https://…/photo.jpg" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Description" hint="Read aloud to people who cannot see it.">
              <input value={block.alt} onChange={(e) => onChange({ ...block, alt: e.target.value })} className={control} />
            </Field>
            <Field label="Opens (optional)">
              <input
                value={block.url ?? ''}
                onChange={(e) => onChange({ ...block, url: e.target.value || undefined })}
                className={control}
                placeholder="https://"
              />
            </Field>
          </div>
        </>
      );
    case 'spacer':
      return (
        <Segmented
          size="sm"
          label="Space"
          value={block.size}
          onChange={(size) => onChange({ ...block, size })}
          options={[
            { value: 's', label: 'Small' },
            { value: 'm', label: 'Medium' },
            { value: 'l', label: 'Large' },
          ]}
        />
      );
    case 'divider':
      return <span className="text-xs text-muted">A thin line between sections.</span>;
  }
}

/** The email as it will arrive, rendered by the same code that sends it. */
function Preview({ content, subject }: { content: EmailDoc; subject?: string }) {
  const tenant = useTenant();
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const key = JSON.stringify(content);
  const [debounced, setDebounced] = useState(key);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(key), 250);
    return () => clearTimeout(t);
  }, [key]);
  const { data, error } = useQuery({
    queryKey: ['email-preview', tenant.id, debounced, tenant.brand],
    queryFn: () => previewEmail(tenant.id, JSON.parse(debounced) as EmailDoc),
    placeholderData: (p) => p,
  });
  return (
    <Card className="sticky top-4 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium">{fill(subject, tenant.name) || 'No subject yet'}</span>
          <span className="truncate text-xs text-muted">
            {tenant.name} · {fill(content.preview, tenant.name) || 'No preview text'}
          </span>
        </div>
        <Segmented
          size="sm"
          label="Preview size"
          value={device}
          onChange={setDevice}
          options={[
            { value: 'desktop', label: <Monitor size={14} aria-label="Desktop" /> },
            { value: 'mobile', label: <Smartphone size={14} aria-label="Phone" /> },
          ]}
        />
      </div>
      <div className="grid place-items-center bg-[#F2F1EE] px-3 py-3">
        {error ? (
          <Notice tone="bad">{error.message}</Notice>
        ) : (
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={data?.html ?? ''}
            className={cx('h-[640px] rounded-lg border-0 bg-[#F2F1EE] transition-[width]', device === 'mobile' ? 'w-[375px] max-w-full' : 'w-full')}
          />
        )}
      </div>
    </Card>
  );
}

/** Sample values for the subject line preview, matching the ones the preview email uses. */
const fill = (s: string | undefined, business: string) =>
  (s ?? '').replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/g, (_, key: string) => ({ first_name: 'Ama', last_name: 'Mensah', email: 'ama@example.com', business_name: business })[key] ?? '');

// ---------------------------------------------------------------- panels

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <div role="dialog" aria-label={title} className="flex h-full w-full max-w-[440px] flex-col gap-4 overflow-y-auto bg-paper px-6 py-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="display m-0 text-[22px]">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="grid size-8 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-muted hover:bg-soft">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

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
  const audience = current.audience;
  const [mode, setMode] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState(() => localInput(new Date(Date.now() + 86_400_000)));
  const schedule = useScheduleCampaign(tenant.id, campaign.id);
  const ready = !saving && list.length === 0;

  return (
    <Sheet title="Review and send" onClose={onClose}>
      <dl className="m-0 grid grid-cols-[64px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-muted">From</dt>
        <dd className="m-0 truncate">
          {tenant.name} &lt;{tenant.fromEmail ?? 'the platform address'}&gt;
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
                <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {p}
              </li>
            ))}
          </ul>
        )}
      </section>

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
        onClick={() => schedule.mutate(mode === 'later' ? new Date(at).toISOString() : null)}
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

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="flex flex-col gap-4">
          {s ? (
            <>
              {s.pending > 0 && (
                <Notice>
                  {nf.format(handed)} of {nf.format(s.total)} handed to Amazon SES. We pace sends so your address keeps a good name with inboxes.
                </Notice>
              )}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Delivered" value={nf.format(s.delivered)} sub={`of ${nf.format(s.total)} sent`} />
                <Stat label="Opened" value={rate(s.opened, s.delivered)} sub={`${nf.format(s.opened)} people`} />
                <Stat label="Clicked" value={rate(s.clicked, s.delivered)} sub={`${nf.format(s.clicked)} people`} />
                <Stat label="Unsubscribed" value={nf.format(s.unsubscribed)} sub={rate(s.unsubscribed, s.delivered)} />
                <Stat label="Bounced" value={nf.format(s.bounced)} sub={rate(s.bounced, s.total)} tone={s.total && s.bounced / s.total > 0.05 ? 'bad' : undefined} />
                <Stat label="Marked as spam" value={nf.format(s.complained)} sub={rate(s.complained, s.total)} tone={s.complained > 0 ? 'bad' : undefined} />
              </div>
              {(campaign.skippedNoConsent || campaign.skippedSuppressed) && (
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

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' }) {
  return (
    <Card className="flex flex-col gap-1 px-4 py-3.5">
      <span className="text-xs text-muted">{label}</span>
      <span className={cx('display text-[28px] leading-none', tone === 'bad' && 'text-bad')}>{value}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </Card>
  );
}
