/**
 * The image block's settings: generate, upload, pick or design a picture without leaving the email.
 */
import { useQuery } from '@tanstack/react-query';
import { ImagePlus, Pencil, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { createContext, lazy, Suspense, useContext, useState } from 'react';
import { libraryQuery, type Asset, type Block } from '../api.ts';
import { ImagePicker } from './images.tsx';
import { useTenant } from './Shell.tsx';
import { cx } from './ui.tsx';

const DesignCanvas = lazy(() => import('./design-canvas.tsx').then((m) => ({ default: m.DesignCanvas })));

/** The email's blocks, so a picture can be suggested from what the email says. */
export const EmailBlocks = createContext<Block[]>([]);

type ImageBlock = Extract<Block, { type: 'image' }>;

/** A first prompt from the email's heading. People edit it; it saves them a blank box. */
export function suggestPrompt(blocks: Block[], businessName: string) {
  const heading = blocks.find((b): b is Extract<Block, { type: 'heading' }> => b.type === 'heading' && b.text.trim() !== '')?.text.replace(/\{\{[^}]*\}\}/g, '').replace(/[,\s]+$/, '').trim();
  return heading ? `A calm, inviting scene for an email from ${businessName} called “${heading}”` : '';
}

/** What a screen reader says for a picture: the words in a design, or what was asked for. */
export function describe(asset: Asset) {
  if (asset.kind === 'design' && asset.design) {
    const words = asset.design.layers.flatMap((l) => (l.type === 'text' ? [l.text.replace(/\s+/g, ' ').trim()] : [])).filter(Boolean);
    if (words.length) return words.join('. ').slice(0, 300);
  }
  return (asset.prompt ?? asset.name).slice(0, 300);
}

const control =
  'h-9 w-full rounded-[10px] border border-rule-strong bg-paper px-2.5 font-[inherit] text-[13px] text-ink outline-none focus:border-ink';

export function ImageBlockSettings({ block, onChange }: { block: ImageBlock; onChange: (b: ImageBlock) => void }) {
  const tenant = useTenant();
  const blocks = useContext(EmailBlocks);
  const { data } = useQuery(libraryQuery(tenant.id));
  const [picker, setPicker] = useState(false);
  const [canvas, setCanvas] = useState<null | { asset?: Asset | null; photo?: Asset | null }>(null);
  const current = data?.assets.find((a) => a.url === block.src) ?? null;

  function use(asset: Asset) {
    // Replace a description we wrote, keep one the owner wrote.
    const ours = !block.alt || (current && block.alt === describe(current));
    onChange({ ...block, src: asset.url, alt: ours ? describe(asset) : block.alt });
    setPicker(false);
    setCanvas(null);
  }

  return (
    <>
      {block.src ? (
        <div className="group relative overflow-hidden rounded-[12px] bg-well shadow-ring">
          <img src={block.src} alt={block.alt} className="block max-h-[220px] w-full object-cover" />
          <div className="absolute inset-x-0 bottom-0 flex gap-1.5 bg-gradient-to-t from-black/50 to-transparent px-2.5 pt-8 pb-2.5">
            <Pill onClick={() => setPicker(true)}>
              <RefreshCw size={13} /> Change
            </Pill>
            <Pill onClick={() => setCanvas(current?.kind === 'design' ? { asset: current } : { photo: current })}>
              <Pencil size={13} /> {current?.kind === 'design' ? 'Edit design' : 'Design with it'}
            </Pill>
            <span className="grow" />
            <Pill onClick={() => onChange({ ...block, src: '' })} label="Remove the picture">
              <Trash2 size={13} />
            </Pill>
          </div>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setPicker(true)}
            className="flex cursor-pointer flex-col items-start gap-1 rounded-[12px] border-[1.5px] border-dashed border-accent/50 bg-tint px-3.5 py-3 text-left font-[inherit] text-ink hover:border-accent"
          >
            <Sparkles size={16} className="text-accent-ink" />
            <span className="text-[13px] font-medium">Generate or choose</span>
            <span className="text-xs text-muted">Made in your colours, or from your pictures</span>
          </button>
          <button
            type="button"
            onClick={() => setCanvas({})}
            className="flex cursor-pointer flex-col items-start gap-1 rounded-[12px] border-[1.5px] border-dashed border-rule-strong bg-soft px-3.5 py-3 text-left font-[inherit] text-ink hover:border-ink"
          >
            <ImagePlus size={16} className="text-muted" />
            <span className="text-[13px] font-medium">Design a header</span>
            <span className="text-xs text-muted">Words, photo and offer sticker</span>
          </button>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Description</span>
          <input value={block.alt} onChange={(e) => onChange({ ...block, alt: e.target.value })} className={control} />
          <span className="text-xs text-faint">Read aloud to people who cannot see it, and shown when pictures are off.</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Opens (optional)</span>
          <input value={block.url ?? ''} onChange={(e) => onChange({ ...block, url: e.target.value || undefined })} className={control} placeholder="https://" />
        </label>
      </div>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">Use a picture that is already online</summary>
        <input value={block.src} onChange={(e) => onChange({ ...block, src: e.target.value })} className={cx(control, 'mt-2')} placeholder="https://…/photo.jpg" aria-label="Picture link" />
      </details>

      {picker && (
        <ImagePicker
          suggested={suggestPrompt(blocks, tenant.name)}
          initialTab={data?.assets.length && block.src ? 'library' : 'generate'}
          onPick={use}
          onDesign={(photo) => {
            setPicker(false);
            setCanvas({ photo });
          }}
          onClose={() => setPicker(false)}
        />
      )}
      {canvas && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-canvas" />}>
          <DesignCanvas asset={canvas.asset} photo={canvas.photo} saveLabel="Add to email" onSaved={use} onClose={() => setCanvas(null)} />
        </Suspense>
      )}
    </>
  );
}

function Pill({ onClick, label, children }: { onClick: () => void; label?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-white/90 px-3 font-[inherit] text-[12.5px] font-medium text-ink backdrop-blur hover:bg-white"
    >
      {children}
    </button>
  );
}
