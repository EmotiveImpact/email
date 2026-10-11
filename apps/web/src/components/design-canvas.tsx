/**
 * The design canvas: headers, banners and offer graphics built from layers (photos, words, shapes
 * and shades) in the business's colours. Saved as a PNG at twice the email size, with its layers,
 * so it can be opened and changed later.
 *
 * Drawing uses Konva (MIT), so what you edit is exactly what is saved.
 */
import { blankDesign, DESIGN_SIZES, designTemplates, layerId, type DesignSize } from '@platform/content/design';
import type Konva from 'konva';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Circle as CircleIcon,
  Download,
  Image as ImageIcon,
  LayoutTemplate,
  Lock,
  Palette,
  Redo2,
  Shapes,
  Square,
  Trash2,
  Type,
  Undo2,
  Unlock,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Ellipse, Group, Image as KImage, Layer as KLayer, Line, Rect, Stage, Star, Text, Transformer } from 'react-konva';
import { useSaveDesign, type Asset, type DesignDoc, type Layer } from '../api.ts';
import { contrast, FONTS, shadesFor } from '../theme.ts';
import { ImagePicker } from './images.tsx';
import { Button, Notice, Segmented, cx } from './ui.tsx';
import { useTenant } from './Shell.tsx';

type Tool = 'templates' | 'text' | 'shapes' | 'photos' | 'brand';
type Brand = ReturnType<typeof useBrand>;

const BODY_FONT = "'Inter Variable', sans-serif";
const SNAP = 6;

function useBrand() {
  const tenant = useTenant();
  return useMemo(() => {
    const shades = shadesFor(tenant.brand?.accent);
    const font = FONTS[tenant.brand?.headingFont ?? 'cal-sans'] ?? FONTS['cal-sans'];
    // White on the accent unless it is too pale to read.
    const onAccent = contrast(shades.accent, '#FFFFFF') >= 3 ? '#FFFFFF' : '#121214';
    return {
      name: tenant.name,
      logoUrl: tenant.brand?.logoUrl,
      heading: font.display,
      headingLabel: font.label,
      swatches: [shades.deep, shades.accent, shades.light, shades.tint, '#FFFFFF', '#121214'],
      shades: { businessName: tenant.name, accent: shades.accent, onAccent, deep: shades.deep, tint: shades.tint },
    };
  }, [tenant]);
}

function luminance(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const rgba = (hex: string, alpha: number) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

/** Loads a picture for drawing. CORS-enabled, so the canvas can still be saved. */
function usePicture(src?: string) {
  const [state, setState] = useState<{ src?: string; img: HTMLImageElement | null; failed: boolean }>({ img: null, failed: false });
  useEffect(() => {
    if (!src) return;
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => setState({ src, img, failed: false });
    img.onerror = () => setState({ src, img: null, failed: true });
    img.src = src;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [src]);
  return state.src === src ? state : { img: null, failed: false };
}

/** Undo and redo over whole designs. Quick runs of the same change (a slider) count as one step. */
function useHistory(initial: DesignDoc) {
  const [state, setState] = useState({ past: [] as DesignDoc[], now: initial, future: [] as DesignDoc[] });
  const last = useRef({ key: '', at: 0 });
  const commit = useCallback((next: DesignDoc, key = '') => {
    const at = Date.now();
    const merge = key !== '' && key === last.current.key && at - last.current.at < 700;
    last.current = { key, at };
    setState((s) => ({ past: merge ? s.past : [...s.past.slice(-60), s.now], now: next, future: [] }));
  }, []);
  const undo = useCallback(() => setState((s) => (s.past.length ? { past: s.past.slice(0, -1), now: s.past.at(-1)!, future: [s.now, ...s.future] } : s)), []);
  const redo = useCallback(() => setState((s) => (s.future.length ? { past: [...s.past, s.now], now: s.future[0]!, future: s.future.slice(1) } : s)), []);
  return { doc: state.now, commit, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}

export type DesignCanvasProps = {
  /** A saved design to change. */
  asset?: Asset | null;
  /** A picture to start a new design from. */
  photo?: Asset | null;
  saveLabel?: string;
  onSaved: (asset: Asset) => void;
  onClose: () => void;
};

export function DesignCanvas({ asset, photo, saveLabel = 'Save design', onSaved, onClose }: DesignCanvasProps) {
  const tenant = useTenant();
  const brand = useBrand();
  const save = useSaveDesign(tenant.id);
  const templates = useMemo(() => designTemplates(brand.shades, photo ? { src: photo.url, assetId: photo.id } : undefined), [brand.shades, photo]);
  const start = asset?.design ?? (photo ? templates[0]!.doc : templates[0]!.doc);
  const { doc, commit, undo, redo, canUndo, canRedo } = useHistory(start);
  const [name, setName] = useState(asset?.name ?? (photo ? `${photo.name} header` : 'Header'));
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>(asset ? 'text' : 'templates');
  const [picking, setPicking] = useState<null | 'add' | 'replace'>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const stage = useRef<Konva.Stage>(null);
  const area = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 800, height: 600 });
  const fontsReady = useFontsReady(brand.heading);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => entry && setRoom({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const zoom = Math.max(0.3, Math.min(2, (room.width - 64) / doc.width, (room.height - 120) / doc.height));

  const layer = doc.layers.find((l) => l.id === selected) ?? null;
  const update = useCallback(
    (id: string, patch: Partial<Layer>, key?: string) => commit({ ...doc, layers: doc.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)) }, key ?? `${id}:${Object.keys(patch).join()}`),
    [doc, commit],
  );
  const add = useCallback(
    (added: Layer | Layer[]) => {
      const list = Array.isArray(added) ? added : [added];
      commit({ ...doc, layers: [...doc.layers, ...list] });
      setSelected(list.at(-1)!.id);
    },
    [doc, commit],
  );
  const remove = useCallback(
    (id: string) => {
      commit({ ...doc, layers: doc.layers.filter((l) => l.id !== id) });
      setSelected(null);
    },
    [doc, commit],
  );
  const restack = (id: string, by: 1 | -1) => {
    const i = doc.layers.findIndex((l) => l.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= doc.layers.length) return;
    const layers = [...doc.layers];
    [layers[i], layers[j]] = [layers[j]!, layers[i]!];
    commit({ ...doc, layers });
  };

  // Keyboard: delete, nudge, undo and redo, unless typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.closest('input, textarea, select, [contenteditable]') !== null);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        if (typing) return;
        e.preventDefault();
        (e.shiftKey ? redo : undo)();
        return;
      }
      if (typing || !layer || layer.locked) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        remove(layer.id);
      }
      const step = e.shiftKey ? 10 : 1;
      const move: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const by = move[e.key];
      if (by) {
        e.preventDefault();
        update(layer.id, { x: layer.x + by[0], y: layer.y + by[1] }, `${layer.id}:nudge`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layer, remove, update, undo, redo]);

  function picture() {
    setSelected(null);
    // Wait a frame so the selection handles are gone before drawing.
    return new Promise<string>((resolve, reject) =>
      requestAnimationFrame(() => {
        try {
          resolve(stage.current!.toDataURL({ mimeType: 'image/png', pixelRatio: 2 / zoom }));
        } catch {
          reject(new Error('A picture in this design comes from a site that does not allow it to be reused. Upload the picture instead, then try again.'));
        }
      }),
    );
  }

  async function onSave() {
    setExportError(null);
    try {
      const png = await picture();
      save.mutate({ id: asset?.kind === 'design' ? asset.id : undefined, name: name.trim() || 'Design', design: doc, png }, { onSuccess: onSaved });
    } catch (error) {
      setExportError((error as Error).message);
    }
  }

  async function onDownload() {
    setExportError(null);
    try {
      const a = document.createElement('a');
      a.href = await picture();
      a.download = `${(name.trim() || 'design').replace(/[^\w -]+/g, '')}.png`;
      a.click();
    } catch (error) {
      setExportError((error as Error).message);
    }
  }

  function addPhoto(picked: Asset) {
    setPicking(null);
    if (picking === 'replace' && layer?.type === 'image') {
      update(layer.id, { src: picked.url, assetId: picked.id, name: picked.name });
      return;
    }
    const ratio = picked.width / picked.height;
    const width = Math.min(doc.width, doc.height * ratio);
    add({ id: layerId(), type: 'image', name: picked.name, src: picked.url, assetId: picked.id, fit: 'cover', x: (doc.width - width) / 2, y: 0, width, height: width / ratio, rotation: 0, opacity: 1, locked: false });
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col gap-3 bg-canvas p-3" role="dialog" aria-label="Design">
      <header className="flex flex-wrap items-center gap-3 px-1">
        <button type="button" aria-label="Close the canvas" onClick={onClose} className="grid size-10 cursor-pointer place-items-center rounded-full border-0 bg-paper text-ink shadow-ring hover:bg-soft">
          <X size={18} />
        </button>
        <div className="flex min-w-0 flex-col">
          <span className="eyebrow">{DESIGN_SIZES[sizeOf(doc)]?.label ?? 'Design'} · {doc.width} × {doc.height}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Design name"
            className="display -ml-1 w-[min(360px,50vw)] rounded-md border-0 bg-transparent px-1 text-[24px] text-ink outline-none hover:bg-white/60 focus:bg-paper"
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex h-10 items-center rounded-full bg-paper px-1 shadow-ring">
            <IconButton label="Undo" onClick={undo} disabled={!canUndo}>
              <Undo2 size={16} />
            </IconButton>
            <IconButton label="Redo" onClick={redo} disabled={!canRedo}>
              <Redo2 size={16} />
            </IconButton>
            <span className="num px-2 text-[12.5px] text-muted">{Math.round(zoom * 100)}%</span>
          </div>
          <Button variant="secondary" onClick={onDownload}>
            <Download size={15} /> Download
          </Button>
          <Button variant="accent" onClick={onSave} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : saveLabel}
          </Button>
        </div>
      </header>

      {(exportError || save.isError) && <Notice tone="bad">{exportError ?? save.error?.message}</Notice>}

      <div className="flex min-h-0 grow gap-3">
        <nav aria-label="Tools" className="flex w-[76px] shrink-0 flex-col gap-1 rounded-[18px] bg-paper p-1.5 shadow-card">
          {(
            [
              ['templates', 'Templates', <LayoutTemplate size={18} />],
              ['text', 'Text', <Type size={18} />],
              ['shapes', 'Shapes', <Shapes size={18} />],
              ['photos', 'Photos', <ImageIcon size={18} />],
              ['brand', 'Brand', <Palette size={18} />],
            ] as const
          ).map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tool === id}
              onClick={() => (id === 'photos' ? setPicking('add') : setTool(id))}
              className={cx(
                'flex cursor-pointer flex-col items-center gap-1 rounded-[12px] border-0 px-1 py-2.5 font-[inherit] text-[11px] transition',
                tool === id ? 'bg-ink text-white' : 'bg-transparent text-muted hover:bg-soft hover:text-ink',
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </nav>

        <aside className="flex w-[248px] shrink-0 flex-col gap-4 overflow-y-auto rounded-[18px] bg-paper p-4 shadow-card">
          <ToolPanel
            tool={tool}
            brand={brand}
            doc={doc}
            templates={templates}
            onTemplate={(t) => {
              commit({ ...t, layers: t.layers.map((l) => ({ ...l, id: layerId() })) });
              setSelected(null);
            }}
            onAdd={add}
            onBackground={(background) => commit({ ...doc, background }, 'background')}
          />
          <div className="mt-auto flex flex-col gap-1.5 border-t border-rule pt-3">
            <span className="eyebrow">Layers</span>
            {doc.layers.length === 0 && <span className="text-xs text-muted">Nothing yet. Pick a template or add some words.</span>}
            <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
              {[...doc.layers].reverse().map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(l.id)}
                    className={cx(
                      'flex w-full cursor-pointer items-center gap-2 rounded-[10px] border-0 px-2 py-1.5 text-left font-[inherit] text-[13px]',
                      selected === l.id ? 'bg-tint font-medium text-accent-ink' : 'bg-transparent text-ink hover:bg-soft',
                    )}
                  >
                    <LayerIcon layer={l} />
                    <span className="grow truncate">{layerLabel(l)}</span>
                    {l.locked && <Lock size={12} className="text-faint" />}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </aside>

        <div ref={area} className="dots relative flex min-w-0 grow flex-col items-center justify-center gap-3 overflow-hidden rounded-[18px]">
          <span className="text-xs text-muted">{DESIGN_SIZES[sizeOf(doc)]?.label ?? 'Design'} · saved at {doc.width * 2} × {doc.height * 2} for sharp phones</span>
          <div className="shadow-lift" style={{ width: doc.width * zoom, height: doc.height * zoom }}>
            <Artboard stageRef={stage} doc={doc} zoom={zoom} brand={brand} selected={selected} onSelect={setSelected} onChange={update} fontsReady={fontsReady} />
          </div>
          <div className="flex items-center gap-2 rounded-full bg-paper py-1.5 pr-1.5 pl-4 text-[12.5px] text-muted shadow-ring">
            Size
            <Segmented
              size="sm"
              label="Size"
              value={sizeOf(doc)}
              onChange={(size: DesignSize) => commit({ ...doc, width: DESIGN_SIZES[size].width, height: DESIGN_SIZES[size].height })}
              options={(Object.keys(DESIGN_SIZES) as DesignSize[]).map((s) => ({ value: s, label: DESIGN_SIZES[s].label }))}
            />
          </div>
        </div>

        <aside className="flex w-[280px] shrink-0 flex-col gap-4 overflow-y-auto rounded-[18px] bg-paper p-4 shadow-card">
          {layer ? (
            <Properties
              layer={layer}
              brand={brand}
              onChange={(patch, key) => update(layer.id, patch, key)}
              onRemove={() => remove(layer.id)}
              onRestack={(by) => restack(layer.id, by)}
              onReplacePhoto={() => setPicking('replace')}
            />
          ) : (
            <>
              <div className="flex flex-col gap-0.5">
                <span className="eyebrow">Selected</span>
                <h3 className="display m-0 text-[20px]">Background</h3>
              </div>
              <ColourField label="Colour" value={doc.background} brand={brand} onChange={(background) => commit({ ...doc, background }, 'background')} />
              <p className="m-0 text-xs leading-relaxed text-muted">Click anything on the canvas to change it. Drag to move, pull the corners to resize, and use the arrow keys to nudge.</p>
            </>
          )}
        </aside>
      </div>

      {picking && (
        <ImagePicker
          title={picking === 'replace' ? 'Swap the photo' : 'Add a photo'}
          initialTab="library"
          pickLabel={picking === 'replace' ? 'Swap it in' : 'Add to design'}
          onPick={addPhoto}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}

function sizeOf(doc: DesignDoc): DesignSize {
  const found = (Object.keys(DESIGN_SIZES) as DesignSize[]).find((s) => DESIGN_SIZES[s].width === doc.width && DESIGN_SIZES[s].height === doc.height);
  return found ?? 'header';
}

/** Waits for the heading and body fonts, so words are measured and drawn in the right face. */
function useFontsReady(heading: string) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    const family = heading.split(',')[0]!.trim();
    Promise.all([document.fonts.load(`400 40px ${family}`), document.fonts.load(`500 16px 'Inter Variable'`), document.fonts.load(`700 16px 'Inter Variable'`)])
      .catch(() => undefined)
      .then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [heading]);
  return ready;
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-8 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-ink hover:bg-soft disabled:cursor-default disabled:text-faint disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

const layerLabel = (l: Layer) => l.name || (l.type === 'text' ? l.text.split('\n')[0] || 'Words' : l.type === 'image' ? 'Photo' : l.type === 'shade' ? 'Shade' : 'Shape');

function LayerIcon({ layer }: { layer: Layer }) {
  const box = 'grid size-6 shrink-0 place-items-center rounded-md bg-soft text-[10px] text-muted';
  if (layer.type === 'text') return <span className={box}>Aa</span>;
  if (layer.type === 'image') return <img src={layer.src} alt="" className="size-6 shrink-0 rounded-md object-cover" />;
  if (layer.type === 'shade') return <span className="size-6 shrink-0 rounded-md" style={{ background: `linear-gradient(90deg, ${layer.colour}, transparent)` }} />;
  return <span className={box}><span className="size-3 rounded-full" style={{ background: layer.fill }} /></span>;
}

// ---------------------------------------------------------------- drawing

function Artboard({
  stageRef,
  doc,
  zoom,
  brand,
  selected,
  onSelect,
  onChange,
  fontsReady,
}: {
  stageRef: React.RefObject<Konva.Stage | null>;
  doc: DesignDoc;
  zoom: number;
  brand: Brand;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<Layer>, key?: string) => void;
  fontsReady: boolean;
}) {
  const transformer = useRef<Konva.Transformer>(null);
  const [guides, setGuides] = useState({ x: false, y: false });
  const chosen = doc.layers.find((l) => l.id === selected);

  useEffect(() => {
    const t = transformer.current;
    const node = selected ? stageRef.current?.findOne(`#${selected}`) : null;
    if (!t) return;
    t.nodes(node && chosen && !chosen.locked ? [node] : []);
    t.getLayer()?.batchDraw();
  }, [selected, chosen, doc, stageRef, fontsReady]);

  /** Pulls a dragged layer onto the centre lines when it comes close, and shows the line. */
  function snap(node: Konva.Node) {
    const box = node.getClientRect({ relativeTo: node.getLayer() ?? undefined });
    const dx = doc.width / 2 - (box.x + box.width / 2);
    const dy = doc.height / 2 - (box.y + box.height / 2);
    const x = Math.abs(dx) < SNAP;
    const y = Math.abs(dy) < SNAP;
    if (x) node.x(node.x() + dx);
    if (y) node.y(node.y() + dy);
    setGuides({ x, y });
  }

  return (
    <Stage
      ref={stageRef}
      width={doc.width * zoom}
      height={doc.height * zoom}
      scaleX={zoom}
      scaleY={zoom}
      onMouseDown={(e) => (e.target === e.target.getStage() || e.target.name() === 'background') && onSelect(null)}
      onTouchStart={(e) => (e.target === e.target.getStage() || e.target.name() === 'background') && onSelect(null)}
    >
      <KLayer>
        <Rect name="background" x={0} y={0} width={doc.width} height={doc.height} fill={doc.background} />
        {doc.layers.map((l) => (
          <Group
            key={l.id}
            id={l.id}
            x={l.x}
            y={l.y}
            rotation={l.rotation}
            opacity={l.opacity}
            draggable={!l.locked}
            onMouseDown={() => onSelect(l.id)}
            onTap={() => onSelect(l.id)}
            onDragMove={(e) => snap(e.target)}
            onDragEnd={(e) => {
              setGuides({ x: false, y: false });
              onChange(l.id, { x: Math.round(e.target.x()), y: Math.round(e.target.y()) }, `${l.id}:drag:${Date.now()}`);
            }}
            onTransformEnd={(e) => {
              const node = e.target;
              const sx = node.scaleX();
              const sy = node.scaleY();
              node.scaleX(1);
              node.scaleY(1);
              const patch: Partial<Layer> = {
                x: Math.round(node.x()),
                y: Math.round(node.y()),
                rotation: Math.round(node.rotation()),
                width: Math.max(8, Math.round(l.width * sx)),
                height: Math.max(8, Math.round(l.height * sy)),
              };
              if (l.type === 'text') Object.assign(patch, { size: Math.max(6, Math.round(l.size * sy)) });
              onChange(l.id, patch, `${l.id}:transform:${Date.now()}`);
            }}
          >
            <Shape layer={l} brand={brand} fontsReady={fontsReady} />
          </Group>
        ))}
        {guides.x && <Line points={[doc.width / 2, 0, doc.width / 2, doc.height]} stroke="#FF3D9A" strokeWidth={1 / zoom} dash={[4 / zoom, 4 / zoom]} listening={false} />}
        {guides.y && <Line points={[0, doc.height / 2, doc.width, doc.height / 2]} stroke="#FF3D9A" strokeWidth={1 / zoom} dash={[4 / zoom, 4 / zoom]} listening={false} />}
        <Transformer
          ref={transformer}
          rotateEnabled
          keepRatio={chosen?.type === 'text' || chosen?.type === 'image'}
          enabledAnchors={chosen?.type === 'text' ? ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right'] : undefined}
          anchorSize={9}
          anchorCornerRadius={5}
          borderStroke="#2D6CD3"
          anchorStroke="#2D6CD3"
          rotationSnaps={[0, 90, 180, 270]}
          boundBoxFunc={(oldBox, box) => (box.width < 8 || box.height < 8 ? oldBox : box)}
        />
      </KLayer>
    </Stage>
  );
}

function Shape({ layer, brand, fontsReady }: { layer: Layer; brand: Brand; fontsReady: boolean }) {
  switch (layer.type) {
    case 'text':
      return (
        <Text
          key={fontsReady ? 'ready' : 'loading'}
          text={layer.uppercase ? layer.text.toUpperCase() : layer.text}
          width={layer.width}
          fontFamily={layer.font === 'heading' ? brand.heading : BODY_FONT}
          fontSize={layer.size}
          fontStyle={String(layer.weight)}
          fill={layer.colour}
          align={layer.align}
          lineHeight={layer.lineHeight}
          letterSpacing={layer.letterSpacing}
        />
      );
    case 'shape':
      if (layer.shape === 'circle') return <Ellipse x={layer.width / 2} y={layer.height / 2} radiusX={layer.width / 2} radiusY={layer.height / 2} fill={layer.fill} />;
      if (layer.shape === 'burst') {
        const r = Math.min(layer.width, layer.height) / 2;
        return <Star x={layer.width / 2} y={layer.height / 2} numPoints={16} outerRadius={r} innerRadius={r * 0.88} fill={layer.fill} scaleX={layer.width / 2 / r} scaleY={layer.height / 2 / r} />;
      }
      return <Rect width={layer.width} height={layer.height} fill={layer.fill} cornerRadius={layer.shape === 'pill' ? Math.min(layer.width, layer.height) / 2 : layer.cornerRadius} />;
    case 'shade': {
      const ends = { right: [0, 0, layer.width, 0], left: [layer.width, 0, 0, 0], down: [0, 0, 0, layer.height], up: [0, layer.height, 0, 0] }[layer.direction];
      return (
        <Rect
          width={layer.width}
          height={layer.height}
          fillLinearGradientStartPoint={{ x: ends[0]!, y: ends[1]! }}
          fillLinearGradientEndPoint={{ x: ends[2]!, y: ends[3]! }}
          fillLinearGradientColorStops={[0, rgba(layer.colour, layer.from), 1, rgba(layer.colour, layer.to)]}
        />
      );
    }
    case 'image':
      return <Photo layer={layer} />;
  }
}

function Photo({ layer }: { layer: Extract<Layer, { type: 'image' }> }) {
  const { img, failed } = usePicture(layer.src);
  if (!img) return <Rect width={layer.width} height={layer.height} fill={failed ? '#F3D9D4' : '#E6E5E0'} />;
  if (layer.fit === 'contain') {
    const r = Math.min(layer.width / img.width, layer.height / img.height);
    const w = img.width * r;
    const h = img.height * r;
    return <KImage image={img} x={(layer.width - w) / 2} y={(layer.height - h) / 2} width={w} height={h} />;
  }
  const r = Math.max(layer.width / img.width, layer.height / img.height);
  const cw = layer.width / r;
  const ch = layer.height / r;
  return <KImage image={img} width={layer.width} height={layer.height} crop={{ x: (img.width - cw) / 2, y: (img.height - ch) / 2, width: cw, height: ch }} />;
}

// ---------------------------------------------------------------- panels

function ToolPanel({
  tool,
  brand,
  doc,
  templates,
  onTemplate,
  onAdd,
  onBackground,
}: {
  tool: Tool;
  brand: Brand;
  doc: DesignDoc;
  templates: { id: string; label: string; doc: DesignDoc }[];
  onTemplate: (doc: DesignDoc) => void;
  onAdd: (layer: Layer | Layer[]) => void;
  onBackground: (colour: string) => void;
}) {
  const base = { id: layerId(), rotation: 0, opacity: 1, locked: false, name: '' };
  const centre = (w: number, h: number) => ({ x: Math.round((doc.width - w) / 2), y: Math.round((doc.height - h) / 2), width: w, height: h });
  // Headings sit on the left, so badges and stickers start on the right where they will not cover words.
  const right = (w: number, h: number) => ({ ...centre(w, h), x: Math.max(0, doc.width - w - 36) });
  const light = luminance(doc.background) > 0.4;
  const ink = light ? '#121214' : '#FFFFFF';

  if (tool === 'templates') {
    return (
      <div className="flex flex-col gap-3">
        <span className="eyebrow">Start from</span>
        {templates.map((t) => (
          <button key={t.id} type="button" onClick={() => onTemplate(t.doc)} className="flex cursor-pointer flex-col gap-1.5 rounded-[12px] border-0 bg-transparent p-0 text-left font-[inherit]">
            <TemplatePreview doc={t.doc} brand={brand} />
            <span className="text-[13px] font-medium text-ink">{t.label}</span>
          </button>
        ))}
        <button type="button" onClick={() => onTemplate(blankDesign('header', '#FFFFFF'))} className="cursor-pointer rounded-[12px] border border-dashed border-rule-strong bg-transparent py-3 font-[inherit] text-[13px] text-muted hover:bg-soft">
          Blank header
        </button>
      </div>
    );
  }
  if (tool === 'text') {
    const add = (size: number, font: 'heading' | 'body', text: string, weight: 400 | 500 | 600 = 400) =>
      onAdd({ ...base, type: 'text', text, font, size, weight, colour: ink, align: 'left', lineHeight: font === 'heading' ? 1.05 : 1.3, letterSpacing: 0, uppercase: false, ...centre(Math.min(420, doc.width - 60), size * 1.2) });
    return (
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Add words</span>
        <AddButton onClick={() => add(44, 'heading', 'A heading')}>
          <span className="text-[22px]" style={{ fontFamily: brand.heading }}>A heading</span>
        </AddButton>
        <AddButton onClick={() => add(20, 'heading', 'A smaller heading')}>
          <span className="text-[16px]" style={{ fontFamily: brand.heading }}>A smaller heading</span>
        </AddButton>
        <AddButton onClick={() => add(15, 'body', 'A line of text', 500)}>
          <span className="text-[13px]">A line of text</span>
        </AddButton>
      </div>
    );
  }
  if (tool === 'shapes') {
    const shape = (s: 'rect' | 'circle' | 'pill' | 'burst', w: number, h: number) =>
      onAdd({ ...base, type: 'shape', shape: s, fill: brand.shades.accent, cornerRadius: s === 'rect' ? 12 : 0, ...(s === 'rect' ? centre(w, h) : right(w, h)) });
    // A sticker is only useful with words on it, so it arrives with an offer people can retype.
    const sticker = () => {
      const at = right(150, 150);
      onAdd([
        { ...base, name: 'Sticker', type: 'shape', shape: 'burst', fill: brand.shades.accent, cornerRadius: 0, ...at },
        { ...base, id: layerId(), name: 'Sticker words', type: 'text', text: '20%\noff', font: 'heading', size: 30, weight: 600, colour: brand.shades.onAccent, align: 'center', lineHeight: 0.95, letterSpacing: 0, uppercase: false, x: at.x + 15, y: at.y + 46, width: 120, height: 58 },
      ]);
    };
    return (
      <div className="flex flex-col gap-3">
        <span className="eyebrow">Shapes</span>
        <div className="grid grid-cols-2 gap-2">
          <AddButton onClick={() => shape('circle', 140, 140)}>
            <CircleIcon size={22} className="text-accent-ink" /> Circle
          </AddButton>
          <AddButton onClick={sticker}>
            <Star8 /> Sticker
          </AddButton>
          <AddButton onClick={() => shape('rect', 200, 120)}>
            <Square size={22} className="text-accent-ink" /> Box
          </AddButton>
          <AddButton onClick={() => shape('pill', 180, 52)}>
            <span className="h-4 w-8 rounded-full bg-accent" /> Pill
          </AddButton>
        </div>
        <span className="eyebrow mt-2">Shade</span>
        <AddButton onClick={() => onAdd({ ...base, type: 'shade', colour: brand.shades.deep, from: 0.85, to: 0, direction: 'right', x: 0, y: 0, width: doc.width, height: doc.height })}>
          <span className="h-5 w-10 rounded" style={{ background: `linear-gradient(90deg, ${brand.shades.deep}, transparent)` }} /> Fade for words
        </AddButton>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <span className="eyebrow">{brand.name} brand</span>
      <div className="flex flex-wrap gap-2">
        {brand.swatches.map((c) => (
          <button key={c} type="button" aria-label={`Background ${c}`} title="Use as background" onClick={() => onBackground(c)} className="size-8 cursor-pointer rounded-full border-0 shadow-ring" style={{ background: c }} />
        ))}
      </div>
      <span className="display text-[20px]" style={{ fontFamily: brand.heading }}>
        {brand.headingLabel}
      </span>
      <span className="-mt-2 text-[13px] text-muted">Inter for smaller words</span>
      {brand.logoUrl && (
        <AddButton
          onClick={() => {
            const width = 120;
            onAdd({ ...base, type: 'image', name: 'Logo', src: brand.logoUrl!, fit: 'contain', x: 30, y: 24, width, height: 48 });
          }}
        >
          <img src={brand.logoUrl} alt="" className="h-6 max-w-16 object-contain" /> Add logo
        </AddButton>
      )}
      <p className="m-0 rounded-[12px] bg-soft px-3 py-2.5 text-xs leading-relaxed text-muted">Colours and fonts come from Appearance, so every design starts on-brand.</p>
    </div>
  );
}

function Star8() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden className="text-accent-ink">
      <path fill="currentColor" d="m12 1 2.2 3.3 3.8-1.2.4 4 3.8 1.5-2 3.4 2 3.4-3.8 1.5-.4 4-3.8-1.2L12 23l-2.2-3.3-3.8 1.2-.4-4-3.8-1.5 2-3.4-2-3.4 3.8-1.5.4-4 3.8 1.2z" />
    </svg>
  );
}

function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[12px] border-0 bg-soft px-3 py-2 text-left font-[inherit] text-[13px] text-ink transition hover:bg-well">
      {children}
    </button>
  );
}

/** A small live drawing of a template, so the choice is visual. */
function TemplatePreview({ doc, brand }: { doc: DesignDoc; brand: Brand }) {
  const width = 216;
  const zoom = width / doc.width;
  return (
    <div className="overflow-hidden rounded-[10px] shadow-ring" style={{ width, height: doc.height * zoom }}>
      <Stage width={width} height={doc.height * zoom} scaleX={zoom} scaleY={zoom} listening={false}>
        <KLayer>
          <Rect width={doc.width} height={doc.height} fill={doc.background} />
          {doc.layers.map((l) => (
            <Group key={l.id} x={l.x} y={l.y} rotation={l.rotation} opacity={l.opacity}>
              <Shape layer={l} brand={brand} fontsReady />
            </Group>
          ))}
        </KLayer>
      </Stage>
    </div>
  );
}

function Properties({
  layer,
  brand,
  onChange,
  onRemove,
  onRestack,
  onReplacePhoto,
}: {
  layer: Layer;
  brand: Brand;
  onChange: (patch: Partial<Layer>, key?: string) => void;
  onRemove: () => void;
  onRestack: (by: 1 | -1) => void;
  onReplacePhoto: () => void;
}) {
  const field = 'h-9 w-full rounded-[10px] border border-rule-strong bg-paper px-2.5 font-[inherit] text-[13px] text-ink outline-none focus:border-ink';
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="eyebrow">Selected</span>
          <h3 className="display m-0 truncate text-[20px]">{layerLabel(layer)}</h3>
        </div>
        <div className="flex">
          <IconButton label="Bring forward" onClick={() => onRestack(1)}>
            <ChevronUp size={16} />
          </IconButton>
          <IconButton label="Send back" onClick={() => onRestack(-1)}>
            <ChevronDown size={16} />
          </IconButton>
          <IconButton label={layer.locked ? 'Unlock' : 'Lock'} onClick={() => onChange({ locked: !layer.locked })}>
            {layer.locked ? <Lock size={15} /> : <Unlock size={15} />}
          </IconButton>
          <IconButton label="Delete" onClick={onRemove}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      </div>

      {layer.type === 'text' && (
        <>
          <Labelled label="Words">
            <textarea value={layer.text} onChange={(e) => onChange({ text: e.target.value }, `${layer.id}:text`)} rows={3} className={cx(field, 'h-auto resize-y py-2 leading-snug')} />
          </Labelled>
          <div className="grid grid-cols-2 gap-2">
            <Labelled label="Font">
              <select value={layer.font} onChange={(e) => onChange({ font: e.target.value as 'heading' | 'body' })} className={field}>
                <option value="heading">{brand.headingLabel}</option>
                <option value="body">Inter</option>
              </select>
            </Labelled>
            <Labelled label="Weight">
              <select value={layer.weight} onChange={(e) => onChange({ weight: Number(e.target.value) as 400 | 500 | 600 | 700 })} className={field}>
                <option value={400}>Regular</option>
                <option value={500}>Medium</option>
                <option value={600}>Semibold</option>
                <option value={700}>Bold</option>
              </select>
            </Labelled>
            <Num label="Size" value={layer.size} min={6} max={240} onChange={(size) => onChange({ size }, `${layer.id}:size`)} />
            <Num label="Spacing" value={layer.letterSpacing} min={-5} max={20} step={0.5} onChange={(letterSpacing) => onChange({ letterSpacing }, `${layer.id}:ls`)} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <Segmented
              size="sm"
              label="Align"
              value={layer.align}
              onChange={(align) => onChange({ align })}
              options={[
                { value: 'left', label: <AlignLeft size={14} aria-label="Left" /> },
                { value: 'center', label: <AlignCenter size={14} aria-label="Centre" /> },
                { value: 'right', label: <AlignRight size={14} aria-label="Right" /> },
              ]}
            />
            <label className="flex items-center gap-1.5 text-[13px]">
              <input type="checkbox" checked={layer.uppercase} onChange={(e) => onChange({ uppercase: e.target.checked })} /> Capitals
            </label>
          </div>
          <ColourField label="Colour" value={layer.colour} brand={brand} onChange={(colour) => onChange({ colour }, `${layer.id}:colour`)} />
        </>
      )}

      {layer.type === 'shape' && (
        <>
          <Labelled label="Shape">
            <Segmented
              size="sm"
              label="Shape"
              value={layer.shape}
              onChange={(shape) => onChange({ shape })}
              options={[
                { value: 'circle', label: 'Circle' },
                { value: 'burst', label: 'Sticker' },
                { value: 'rect', label: 'Box' },
                { value: 'pill', label: 'Pill' },
              ]}
            />
          </Labelled>
          <ColourField label="Fill" value={layer.fill} brand={brand} onChange={(fill) => onChange({ fill }, `${layer.id}:fill`)} />
          {layer.shape === 'rect' && <Num label="Corners" value={layer.cornerRadius} min={0} max={200} onChange={(cornerRadius) => onChange({ cornerRadius }, `${layer.id}:radius`)} />}
        </>
      )}

      {layer.type === 'shade' && (
        <>
          <ColourField label="Colour" value={layer.colour} brand={brand} onChange={(colour) => onChange({ colour }, `${layer.id}:colour`)} />
          <Labelled label="Fades towards">
            <Segmented
              size="sm"
              label="Fades towards"
              value={layer.direction}
              onChange={(direction) => onChange({ direction })}
              options={[
                { value: 'right', label: <ArrowRight size={14} aria-label="Right" /> },
                { value: 'left', label: <ArrowLeft size={14} aria-label="Left" /> },
                { value: 'up', label: <ArrowUp size={14} aria-label="Up" /> },
                { value: 'down', label: <ArrowDown size={14} aria-label="Down" /> },
              ]}
            />
          </Labelled>
          <Range label="Strength" value={layer.from} onChange={(from) => onChange({ from }, `${layer.id}:from`)} />
        </>
      )}

      {layer.type === 'image' && (
        <>
          <img src={layer.src} alt="" className="aspect-[3/2] w-full rounded-[12px] object-cover shadow-ring" />
          <div className="flex items-center justify-between gap-2">
            <Segmented
              size="sm"
              label="Fit"
              value={layer.fit}
              onChange={(fit) => onChange({ fit })}
              options={[
                { value: 'cover', label: 'Fill' },
                { value: 'contain', label: 'Fit' },
              ]}
            />
            <Button variant="secondary" onClick={onReplacePhoto}>
              Swap photo
            </Button>
          </div>
        </>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Num label="Turn" value={layer.rotation} min={-360} max={360} onChange={(rotation) => onChange({ rotation }, `${layer.id}:rotation`)} suffix="°" />
        <Num label="See-through" value={Math.round((1 - layer.opacity) * 100)} min={0} max={95} onChange={(v) => onChange({ opacity: 1 - v / 100 }, `${layer.id}:opacity`)} suffix="%" />
      </div>
    </>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      {children}
    </label>
  );
}

function Num({ label, value, min, max, step = 1, suffix, onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <label className="flex h-9 items-center justify-between gap-2 rounded-[10px] bg-soft px-2.5 text-[12.5px] text-muted">
      {label}
      <span className="flex items-center gap-0.5">
        <input
          type="number"
          value={Math.round(value * 10) / 10}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
          }}
          className="num w-12 border-0 bg-transparent text-right font-[inherit] text-[13px] text-ink outline-none"
        />
        {suffix}
      </span>
    </label>
  );
}

function Range({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      <input type="range" min={0} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} className="accent-(--accent)" />
    </label>
  );
}

function ColourField({ label, value, brand, onChange }: { label: string; value: string; brand: Brand; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {brand.swatches.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            aria-pressed={c.toUpperCase() === value.toUpperCase()}
            onClick={() => onChange(c)}
            className="size-7 cursor-pointer rounded-full border-0"
            style={{ background: c, boxShadow: c.toUpperCase() === value.toUpperCase() ? `0 0 0 2px #fff, 0 0 0 3.5px ${c === '#FFFFFF' ? '#121214' : c}` : '0 0 0 1px #12121420' }}
          />
        ))}
        <label className="relative grid size-7 cursor-pointer place-items-center rounded-full bg-soft text-[15px] text-muted shadow-ring" title="Any colour">
          +
          <input type="color" value={value.toLowerCase()} onChange={(e) => onChange(e.target.value.toUpperCase())} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Any colour" />
        </label>
      </div>
    </div>
  );
}
