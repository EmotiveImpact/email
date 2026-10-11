/**
 * The email editor's parts, shared by campaigns and flows: blocks, merge-tag fields and the live
 * preview (rendered by the same code that sends).
 */
import { MERGE_TAGS } from '@platform/content/merge';
import { useDialog } from './dialog.ts';
import { newBlock } from '@platform/content/blocks';
import { useQuery } from '@tanstack/react-query';
import { Braces, CalendarClock, ChevronDown, ChevronUp, Heading, Image, Minus, Monitor, MousePointerClick, MoveVertical, Smartphone, Trash2, Type, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { diaryQuery, previewEmail, type Block, type BlockType, type EmailDoc } from '../api.ts';
import { Card, Notice, Segmented, cx } from './ui.tsx';
import { EmailBlocks, ImageBlockSettings } from './image-block.tsx';
import { useTenant } from './Shell.tsx';

export const control =
  'h-9 w-full rounded-[10px] border border-rule-strong bg-paper px-2.5 font-[inherit] text-[13px] text-ink outline-none focus:border-ink';

export const BLOCKS: { type: BlockType; label: string; icon: ReactNode }[] = [
  { type: 'heading', label: 'Heading', icon: <Heading size={15} /> },
  { type: 'text', label: 'Text', icon: <Type size={15} /> },
  { type: 'button', label: 'Button', icon: <MousePointerClick size={15} /> },
  { type: 'image', label: 'Image', icon: <Image size={15} /> },
  { type: 'slots', label: 'Free times', icon: <CalendarClock size={15} /> },
  { type: 'divider', label: 'Divider', icon: <Minus size={15} /> },
  { type: 'spacer', label: 'Space', icon: <MoveVertical size={15} /> },
];

/** The list of blocks, with a row per block that opens to edit it, and buttons to add more. */
export function BlocksCard({ blocks, onChange }: { blocks: Block[]; onChange: (blocks: Block[]) => void }) {
  const [selected, setSelected] = useState<string | null>(blocks[0]?.id ?? null);
  const openBlock = blocks.some((b) => b.id === selected) ? selected : null;

  function insert(type: BlockType) {
    const block = newBlock(type);
    const at = openBlock ? blocks.findIndex((b) => b.id === openBlock) + 1 : blocks.length;
    onChange([...blocks.slice(0, at), block, ...blocks.slice(at)]);
    setSelected(block.id);
  }
  function move(index: number, by: -1 | 1) {
    const next = [...blocks];
    const [b] = next.splice(index, 1);
    next.splice(index + by, 0, b!);
    onChange(next);
  }

  return (
    <EmailBlocks.Provider value={blocks}>
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
              onChange={(b) => onChange(blocks.map((x) => (x.id === b.id ? b : x)))}
              onRemove={() => onChange(blocks.filter((x) => x.id !== block.id))}
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
    </EmailBlocks.Provider>
  );
}

/** A text input with a menu that drops in merge tags at the cursor. */
export function TagField({
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
    case 'slots':
      return 'Free times from your diary';
  }
}

export function BlockRow({
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

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
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

export function BlockSettings({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
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
      return <ImageBlockSettings block={block} onChange={onChange} />;
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
    case 'slots':
      return (
        <>
          <span className="text-xs leading-relaxed text-muted">
            Up to six free times from your diary, each a button that opens your booking page at that time. Filled in when the email goes, so they are
            never out of date. Fill-quiet-days emails show the quiet day's times.
          </span>
          <SlotsHint />
          <Align value={block.align} onChange={(align) => onChange({ ...block, align })} />
        </>
      );
  }
}

/** Says plainly when free times cannot show yet, since the preview then shows a booking button. */
function SlotsHint() {
  const tenant = useTenant();
  const { data } = useQuery(diaryQuery(tenant.id));
  if (!data || data.connected) return null;
  return <Notice>Your diary is not connected yet, so this shows a “Choose a time” button to your booking page instead. Connect your booking system from Developers to show real times.</Notice>;
}

/** The email as it will arrive, rendered by the same code that sends it. */
export function Preview({
  content,
  subject,
  render,
  renderKey = 'campaign',
}: {
  content: EmailDoc;
  subject?: string;
  /** Renders the email; campaigns by default. Flows pass their own, which knows the flow's free times. */
  render?: (content: EmailDoc) => Promise<{ html: string; slotDay?: string; service?: string }>;
  renderKey?: string;
}) {
  const tenant = useTenant();
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const key = JSON.stringify(content);
  const [debounced, setDebounced] = useState(key);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(key), 250);
    return () => clearTimeout(t);
  }, [key]);
  const { data, error } = useQuery({
    queryKey: ['email-preview', tenant.id, renderKey, debounced, tenant.brand],
    queryFn: (): Promise<{ html: string; slotDay?: string; service?: string }> => (render ?? ((c: EmailDoc) => previewEmail(tenant.id, c)))(JSON.parse(debounced) as EmailDoc),
    placeholderData: (p) => p,
  });
  return (
    <section aria-label="Email preview" className="dots sticky top-4 flex flex-col gap-3 rounded-[18px] p-4">
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13px] font-semibold">{fill(subject, tenant.name, { slotDay: data?.slotDay, service: data?.service }) || 'No subject yet'}</span>
          <span className="truncate text-xs text-muted">
            {tenant.name} · {fill(content.preview, tenant.name, { slotDay: data?.slotDay, service: data?.service }) || 'No preview text'}
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
      <div className="grid place-items-center">
        {error ? (
          <Notice tone="bad">{error.message}</Notice>
        ) : (
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={data?.html ?? ''}
            className={cx(
              'h-[660px] rounded-[10px] border-0 bg-[#F2F1EE] shadow-[0_0_0_1px_#1212140d,0_24px_50px_-28px_#12121459] transition-[width]',
              device === 'mobile' ? 'w-[375px] max-w-full' : 'w-full',
            )}
          />
        )}
      </div>
    </section>
  );
}

/** Sample values for the subject line preview, matching the ones the preview email uses. */
export const fill = (s: string | undefined, business: string, { slotDay = 'Thursday', service = 'appointment' }: { slotDay?: string; service?: string } = {}) =>
  (s ?? '').replace(
    /\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/g,
    (_, key: string) =>
      ({
        first_name: 'Ama',
        last_name: 'Mensah',
        email: 'ama@example.com',
        business_name: business,
        last_service: service,
        weeks_since_visit: '7',
        slot_day: slotDay,
      })[key] ?? '',
  );

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useDialog(onClose);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <div {...dialog} aria-label={title} className="flex h-full w-full max-w-[440px] outline-none flex-col gap-4 overflow-y-auto bg-paper px-6 py-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
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

export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' }) {
  return (
    <Card className="flex flex-col gap-1 px-4 py-3.5">
      <span className="text-xs text-muted">{label}</span>
      <span className={cx('display text-[28px] leading-none', tone === 'bad' && 'text-bad')}>{value}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </Card>
  );
}

const pounds = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
/** Pence as pounds, without pence: £1,240. */
export const money = (pence: number) => pounds.format(pence / 100);

/** What matters most to a salon: the appointments that followed an email. */
export function Booked({ bookings, revenue }: { bookings: number; revenue: number }) {
  return (
    <Card className="flex flex-col gap-1.5 border-accent/30 bg-tint px-5 py-4">
      <span className="text-xs font-medium text-accent-ink">Booked after this email</span>
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="display text-[34px] leading-none">
          {bookings} {bookings === 1 ? 'booking' : 'bookings'}
        </span>
        <span className="display text-[22px] leading-none text-accent-ink">{money(revenue)}</span>
      </span>
      <span className="text-xs leading-snug text-muted">Appointments clients made within five days of getting it, and what they were worth.</span>
    </Card>
  );
}
