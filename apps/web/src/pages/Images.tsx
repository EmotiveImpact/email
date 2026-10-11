import { useSuspenseQuery } from '@tanstack/react-query';
import { Copy, Pencil, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { libraryQuery, useDeleteAsset, type Asset, type AssetKind } from '../api.ts';
import { AssetThumb, fileSize, ImagePicker, KIND_LABEL } from '../components/images.tsx';
import { useTenant } from '../components/Shell.tsx';
import { Button, Card, Notice, PageTitle, Segmented } from '../components/ui.tsx';

/** Konva is large; the canvas loads only when someone opens it. */
export const DesignCanvas = lazy(() => import('../components/design-canvas.tsx').then((m) => ({ default: m.DesignCanvas })));

type Filter = AssetKind | 'all';
type Canvas = { asset?: Asset | null; photo?: Asset | null };

export function Images() {
  const tenant = useTenant();
  const { data } = useSuspenseQuery(libraryQuery(tenant.id));
  const [filter, setFilter] = useState<Filter>('all');
  const [picker, setPicker] = useState<null | 'generate' | 'upload'>(null);
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const remove = useDeleteAsset(tenant.id);
  const shown = data.assets.filter((a) => filter === 'all' || a.kind === filter);
  const count = (k: AssetKind) => data.assets.filter((a) => a.kind === k).length;

  async function copy(asset: Asset) {
    await navigator.clipboard?.writeText(asset.url).catch(() => undefined);
    setCopied(asset.id);
    setTimeout(() => setCopied((id) => (id === asset.id ? null : id)), 1600);
  }

  return (
    <>
      <PageTitle
        eyebrow={`${data.assets.length} ${data.assets.length === 1 ? 'picture' : 'pictures'}`}
        title="Images"
        subtitle="Headers, offers and photos for your emails. Generate them in your colours, design them on the canvas or upload your own."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setPicker('upload')}>
              <Upload size={15} /> Upload
            </Button>
            <Button variant="secondary" onClick={() => setCanvas({})}>
              <Plus size={15} /> New design
            </Button>
            <Button variant="accent" onClick={() => setPicker('generate')}>
              <Sparkles size={15} /> Generate
            </Button>
          </div>
        }
      />

      {!data.images.real && (
        <Notice>Generated pictures are samples in your colours for now. Real photos and illustrations start once an image service is connected.</Notice>
      )}

      <div className="flex items-center justify-between gap-3">
        <Segmented
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'generated', label: `Generated ${count('generated') || ''}`.trim() },
            { value: 'design', label: `Designs ${count('design') || ''}`.trim() },
            { value: 'upload', label: `Uploads ${count('upload') || ''}`.trim() },
          ]}
        />
        <span className="text-xs text-muted">
          {data.images.left} of {data.images.perDay} generations left today
        </span>
      </div>

      {shown.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-14 text-center">
          <span className="grid size-11 place-items-center rounded-full bg-tint text-accent-ink">
            <Sparkles size={20} />
          </span>
          <h2 className="display m-0 text-[22px]">No pictures yet</h2>
          <p className="m-0 max-w-sm text-sm text-muted">Describe a picture and we will make it in your colours, or start a header from a template.</p>
          <div className="flex gap-2">
            <Button variant="accent" onClick={() => setPicker('generate')}>
              Generate a picture
            </Button>
            <Button variant="secondary" onClick={() => setCanvas({})}>
              Design a header
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 @[640px]:grid-cols-2 @[960px]:grid-cols-3 @[1240px]:grid-cols-4">
          {shown.map((asset) => (
            <Card key={asset.id} className="flex flex-col overflow-hidden">
              <AssetThumb asset={asset} className="rounded-none shadow-none" onClick={() => setCanvas(asset.kind === 'design' ? { asset } : { photo: asset })} />
              <div className="flex flex-col gap-1 px-4 pt-3 pb-1">
                <span className="truncate text-[14px] font-medium" title={asset.prompt ?? asset.name}>
                  {asset.name}
                </span>
                <span className="text-xs text-muted">
                  {KIND_LABEL[asset.kind]} · {asset.width} × {asset.height} · {fileSize(asset.bytes)}
                </span>
              </div>
              <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
                <Action label={asset.kind === 'design' ? 'Edit design' : 'Design with it'} onClick={() => setCanvas(asset.kind === 'design' ? { asset } : { photo: asset })}>
                  <Pencil size={14} />
                </Action>
                <Action label={copied === asset.id ? 'Copied' : 'Copy link'} onClick={() => copy(asset)}>
                  <Copy size={14} />
                </Action>
                <span className="grow" />
                <Action label="Remove" onClick={() => confirm(`Remove “${asset.name}” from your pictures? Emails already sent keep showing it.`) && remove.mutate(asset.id)}>
                  <Trash2 size={14} />
                </Action>
              </div>
            </Card>
          ))}
        </div>
      )}

      {picker && (
        <ImagePicker
          title={picker === 'upload' ? 'Upload a picture' : 'Generate a picture'}
          initialTab={picker}
          pickLabel="Done"
          onPick={() => setPicker(null)}
          onDesign={(photo) => {
            setPicker(null);
            setCanvas({ photo });
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {canvas && (
        <Suspense fallback={<div className="fixed inset-0 z-50 bg-canvas" />}>
          <DesignCanvas asset={canvas.asset} photo={canvas.photo} onSaved={() => setCanvas(null)} onClose={() => setCanvas(null)} />
        </Suspense>
      )}
    </>
  );
}

function Action({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-2.5 font-[inherit] text-[12.5px] text-muted hover:bg-soft hover:text-ink">
      {children}
      {label}
    </button>
  );
}
