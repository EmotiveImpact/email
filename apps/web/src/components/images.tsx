/**
 * Pictures in the app: thumbnails, and the picker that generates, uploads or picks one from the
 * library. Used by the email editor and the Images page.
 */
import { useQuery } from '@tanstack/react-query';
import { Check, ImagePlus, Sparkles, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { libraryQuery, useGenerateImages, useUploadAsset, type Asset, type AssetKind, type ImageShape } from '../api.ts';
import { Button, Notice, Segmented, cx } from './ui.tsx';
import { useTenant } from './Shell.tsx';

export const KIND_LABEL: Record<AssetKind, string> = { upload: 'Upload', generated: 'Generated', design: 'Design' };

const SHAPES: { value: ImageShape; label: string }[] = [
  { value: 'wide', label: 'Wide header' },
  { value: 'square', label: 'Square' },
  { value: 'tall', label: 'Tall' },
];

export const fileSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export function AssetThumb({ asset, className, selected, onClick, children }: { asset: Asset; className?: string; selected?: boolean; onClick?: () => void; children?: ReactNode }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cx(
        'group relative block overflow-hidden rounded-[14px] border-0 bg-well p-0 text-left',
        onClick && 'cursor-pointer',
        selected ? 'shadow-[0_0_0_2px_var(--accent)]' : 'shadow-ring',
        className,
      )}
    >
      <img src={asset.url} alt={asset.name} loading="lazy" className="block aspect-[3/2] h-full w-full object-cover" />
      {selected && (
        <span className="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-accent text-on-accent">
          <Check size={14} />
        </span>
      )}
      {children}
    </Tag>
  );
}

type Tab = 'generate' | 'library' | 'upload';

/**
 * A side panel for choosing a picture. `onPick` gets the chosen picture; `onDesign`, when given,
 * opens the canvas with it (or with nothing, for a design from scratch).
 */
export function ImagePicker({
  title = 'Add a picture',
  suggested = '',
  initialTab = 'generate',
  pickLabel = 'Use in email',
  onPick,
  onDesign,
  onClose,
}: {
  title?: string;
  suggested?: string;
  initialTab?: Tab;
  pickLabel?: string;
  onPick: (asset: Asset) => void;
  onDesign?: (asset?: Asset) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [chosen, setChosen] = useState<Asset | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <div role="dialog" aria-label={title} className="flex h-full w-full max-w-[520px] flex-col bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <h2 className="display m-0 flex items-center gap-2.5 text-[22px]">
            <span className="grid size-8 place-items-center rounded-[10px] bg-accent text-on-accent">
              <Sparkles size={16} />
            </span>
            {title}
          </h2>
          <button type="button" aria-label="Close" onClick={onClose} className="grid size-8 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-muted hover:bg-soft">
            <X size={16} />
          </button>
        </div>
        <div className="px-6 pb-4">
          <Segmented
            label="How"
            value={tab}
            onChange={(t) => setTab(t)}
            options={[
              { value: 'generate', label: 'Generate' },
              { value: 'library', label: 'Your pictures' },
              { value: 'upload', label: 'Upload' },
            ]}
          />
        </div>
        <div className="flex min-h-0 grow flex-col gap-4 overflow-y-auto px-6 pb-4">
          {tab === 'generate' && <GenerateTab suggested={suggested} chosen={chosen} onChoose={setChosen} />}
          {tab === 'library' && <LibraryTab chosen={chosen} onChoose={setChosen} />}
          {tab === 'upload' && <UploadTab onUploaded={setChosen} uploaded={chosen?.kind === 'upload' ? chosen : null} />}
        </div>
        <div className="flex gap-2.5 border-t border-rule px-6 py-4">
          <Button variant="accent" className="grow" disabled={!chosen} onClick={() => chosen && onPick(chosen)}>
            {pickLabel}
          </Button>
          {onDesign && (
            <Button variant="secondary" className="grow" onClick={() => onDesign(chosen ?? undefined)}>
              {chosen ? 'Design with it' : 'Design from scratch'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border-0 px-3 font-[inherit] text-[13px] transition',
        on ? 'bg-ink font-medium text-white' : 'bg-soft text-ink hover:bg-well',
      )}
    >
      {children}
    </button>
  );
}

function GenerateTab({ suggested, chosen, onChoose }: { suggested: string; chosen: Asset | null; onChoose: (a: Asset) => void }) {
  const tenant = useTenant();
  const { data } = useQuery(libraryQuery(tenant.id, 'generated'));
  const generate = useGenerateImages(tenant.id);
  const [prompt, setPrompt] = useState(suggested);
  const [style, setStyle] = useState('brand');
  const [shape, setShape] = useState<ImageShape>('wide');
  const [made, setMade] = useState<Asset[]>([]);
  const images = data?.images;
  const count = Math.min(2, images?.left ?? 2);
  const recent = (data?.assets ?? []).filter((a) => !made.some((m) => m.id === a.id)).slice(0, 6);

  function run() {
    if (prompt.trim().length < 3 || count < 1) return;
    generate.mutate(
      { prompt, style, shape, count },
      {
        onSuccess: (assets) => {
          setMade(assets);
          if (assets[0]) onChoose(assets[0]);
        },
      },
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2 rounded-[16px] p-3.5 shadow-[0_0_0_1.5px_var(--accent)]">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && run()}
          rows={3}
          placeholder="A salon chair by a tall window, warm afternoon light, dried flowers on the counter"
          aria-label="Describe the picture"
          className="w-full resize-none border-0 bg-transparent font-[inherit] text-[14px] leading-relaxed text-ink outline-none placeholder:text-faint"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted">{images ? `${images.left} of ${images.limit} left ${images.per === 'day' ? 'today' : 'this month'}` : ' '}</span>
          <Button onClick={run} disabled={generate.isPending || prompt.trim().length < 3 || count < 1}>
            {generate.isPending ? 'Making…' : `Make ${count}`}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Style</span>
        <div className="flex flex-wrap gap-1.5">
          {(images?.styles ?? [{ id: 'brand', label: 'Your brand' }]).map((s) => (
            <Chip key={s.id} on={style === s.id} onClick={() => setStyle(s.id)}>
              {s.id === 'brand' && <span className="size-2 rounded-full bg-accent" />}
              {s.label}
            </Chip>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Shape</span>
        <div className="flex flex-wrap gap-1.5">
          {SHAPES.map((s) => (
            <Chip key={s.value} on={shape === s.value} onClick={() => setShape(s.value)}>
              {s.label}
            </Chip>
          ))}
        </div>
      </div>
      {images && !images.real && (
        <Notice>These are sample pictures in your colours. Real photos and illustrations start once an image service is connected.</Notice>
      )}
      {generate.isError && <Notice tone="bad">{generate.error.message}</Notice>}
      {generate.isPending && (
        <div className="grid grid-cols-2 gap-2.5">
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className="aspect-[3/2] animate-pulse rounded-[14px] bg-well" />
          ))}
        </div>
      )}
      {made.length > 0 && !generate.isPending && <Grid assets={made} chosen={chosen} onChoose={onChoose} />}
      {recent.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="eyebrow">Made before</span>
          <Grid assets={recent} chosen={chosen} onChoose={onChoose} />
        </div>
      )}
    </>
  );
}

function Grid({ assets, chosen, onChoose }: { assets: Asset[]; chosen: Asset | null; onChoose: (a: Asset) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {assets.map((a) => (
        <AssetThumb key={a.id} asset={a} selected={chosen?.id === a.id} onClick={() => onChoose(a)}>
          <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/55 to-transparent px-2.5 pt-5 pb-2 text-[11.5px] text-white">{a.name}</span>
        </AssetThumb>
      ))}
    </div>
  );
}

function LibraryTab({ chosen, onChoose }: { chosen: Asset | null; onChoose: (a: Asset) => void }) {
  const tenant = useTenant();
  const [kind, setKind] = useState<AssetKind | 'all'>('all');
  const { data, isLoading } = useQuery(libraryQuery(tenant.id, kind === 'all' ? undefined : kind));
  return (
    <>
      <Segmented
        size="sm"
        label="Show"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'all', label: 'All' },
          { value: 'generated', label: 'Generated' },
          { value: 'design', label: 'Designs' },
          { value: 'upload', label: 'Uploads' },
        ]}
      />
      {isLoading && <div className="aspect-[3/1] animate-pulse rounded-[14px] bg-well" />}
      {data && data.assets.length === 0 && <p className="m-0 py-6 text-center text-[13px] text-muted">Nothing here yet. Generate or upload a picture first.</p>}
      {data && <Grid assets={data.assets} chosen={chosen} onChoose={onChoose} />}
    </>
  );
}

/** A drop zone that uploads one picture. */
export function UploadTab({ onUploaded, uploaded }: { onUploaded: (a: Asset) => void; uploaded?: Asset | null }) {
  const tenant = useTenant();
  const upload = useUploadAsset(tenant.id);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const send = (file?: File) => file && upload.mutate(file, { onSuccess: onUploaded });
  return (
    <>
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          send(e.dataTransfer.files[0]);
        }}
        className={cx(
          'flex cursor-pointer flex-col items-center gap-2 rounded-[16px] border-[1.5px] border-dashed px-6 py-10 text-center transition',
          over ? 'border-accent bg-tint' : 'border-rule-strong bg-soft hover:bg-well',
        )}
      >
        <span className="grid size-10 place-items-center rounded-full bg-paper text-accent-ink shadow-ring">
          {upload.isPending ? <ImagePlus size={18} className="animate-pulse" /> : <Upload size={18} />}
        </span>
        <span className="text-sm font-medium">{upload.isPending ? 'Uploading…' : 'Drop a picture here, or choose one'}</span>
        <span className="text-xs text-muted">PNG, JPEG or GIF, up to 5 MB. 1200 pixels wide is plenty.</span>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif" className="sr-only" onChange={(e) => send(e.target.files?.[0])} />
      </label>
      {upload.isError && <Notice tone="bad">{upload.error.message}</Notice>}
      {uploaded && (
        <div className="flex flex-col gap-2">
          <AssetThumb asset={uploaded} selected />
          <span className="text-xs text-muted">
            {uploaded.width} × {uploaded.height} · {fileSize(uploaded.bytes)}
            {uploaded.heavy && ' · a smaller file would load faster on phones'}
          </span>
        </div>
      )}
    </>
  );
}
