/**
 * A design made on the canvas: a header, banner or offer graphic built from layers. The layers are
 * kept with the picture, so a design can be opened again and changed. The picture itself is drawn
 * in the browser and saved as a PNG, since that is what every inbox shows.
 */
import { z } from 'zod';

const hex = z.string().regex(/^#[0-9a-f]{6}$/i, 'Colours are hex, such as #1A1A1A.');
const id = z.string().min(1).max(40);

const placed = {
  id,
  name: z.string().max(80).default(''),
  x: z.number().min(-4000).max(4000),
  y: z.number().min(-4000).max(4000),
  width: z.number().min(1).max(4000),
  height: z.number().min(1).max(4000),
  rotation: z.number().min(-360).max(360).default(0),
  opacity: z.number().min(0).max(1).default(1),
  locked: z.boolean().default(false),
};

export const SHAPES = ['rect', 'circle', 'pill', 'burst'] as const;

export const Layer = z.discriminatedUnion('type', [
  z.object({
    ...placed,
    type: z.literal('text'),
    text: z.string().max(500),
    /** `heading` follows the business's heading font; `body` is Inter. */
    font: z.enum(['heading', 'body']).default('heading'),
    size: z.number().min(6).max(240),
    weight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)]).default(400),
    colour: hex,
    align: z.enum(['left', 'center', 'right']).default('left'),
    lineHeight: z.number().min(0.7).max(2.5).default(1.1),
    letterSpacing: z.number().min(-5).max(20).default(0),
    uppercase: z.boolean().default(false),
  }),
  z.object({ ...placed, type: z.literal('shape'), shape: z.enum(SHAPES), fill: hex, cornerRadius: z.number().min(0).max(400).default(0) }),
  z.object({ ...placed, type: z.literal('image'), src: z.string().min(1).max(2000), assetId: z.string().max(40).optional(), fit: z.enum(['cover', 'contain']).default('cover') }),
  /** A colour fading to transparent, laid over a photo so words on it stay readable. */
  z.object({ ...placed, type: z.literal('shade'), colour: hex, from: z.number().min(0).max(1).default(0.85), to: z.number().min(0).max(1).default(0), direction: z.enum(['up', 'down', 'left', 'right']).default('right') }),
]);
export type Layer = z.output<typeof Layer>;
export type LayerInput = z.input<typeof Layer>;
export type LayerType = Layer['type'];

export const DesignDoc = z.object({
  version: z.literal(1).default(1),
  width: z.number().int().min(100).max(1200),
  height: z.number().int().min(100).max(1200),
  background: hex,
  layers: z.array(Layer).max(40).default([]),
});
export type DesignDoc = z.output<typeof DesignDoc>;
export type DesignDocInput = z.input<typeof DesignDoc>;

/** Sizes in email pixels. Pictures are saved at twice this, so they are sharp on phones. */
export const DESIGN_SIZES = {
  header: { width: 600, height: 300, label: 'Email header' },
  banner: { width: 600, height: 200, label: 'Slim banner' },
  square: { width: 600, height: 600, label: 'Square' },
} as const;
export type DesignSize = keyof typeof DESIGN_SIZES;

export type DesignBrand = {
  businessName: string;
  accent: string;
  /** Text on the accent: white, or dark for pale accents. */
  onAccent: string;
  /** A dark shade of the accent, for backgrounds and shades. */
  deep: string;
  /** A pale tint of the accent. */
  tint: string;
};

let counter = 0;
export const layerId = () => `l${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Starting points, already in the business's colours, so nobody faces a blank canvas. */
export function designTemplates(brand: DesignBrand, photo?: { src: string; assetId?: string }) {
  const { width, height } = DESIGN_SIZES.header;
  const name = (text: string) => ({ id: layerId(), name: text });
  const photoHeader: DesignDocInput = {
    width,
    height,
    background: brand.deep,
    layers: [
      ...(photo ? [{ ...name('Photo'), type: 'image' as const, src: photo.src, assetId: photo.assetId, x: 0, y: 0, width, height, fit: 'cover' as const }] : []),
      { ...name('Shade'), type: 'shade', colour: brand.deep, x: 0, y: 0, width, height, from: 0.9, to: 0.05, direction: 'right' },
      { ...name('Business name'), type: 'text', text: brand.businessName, font: 'heading', size: 16, colour: '#FFFFFF', x: 34, y: 30, width: 300, height: 22 },
      { ...name('Heading'), type: 'text', text: 'Thursday has space', font: 'heading', size: 44, colour: '#FFFFFF', x: 34, y: 92, width: 330, height: 100, lineHeight: 1.05 },
      { ...name('Line under'), type: 'text', text: 'Three afternoon times left', font: 'body', size: 15, weight: 500, colour: '#FFFFFF', x: 34, y: 220, width: 330, height: 20, opacity: 0.9 },
    ],
  };
  const offer: DesignDocInput = {
    width,
    height,
    background: brand.tint,
    layers: [
      { ...name('Heading'), type: 'text', text: 'Bring a friend this month', font: 'heading', size: 40, colour: brand.deep, x: 34, y: 70, width: 340, height: 100, lineHeight: 1.05 },
      { ...name('Line under'), type: 'text', text: 'You both get 20% off', font: 'body', size: 16, weight: 500, colour: brand.deep, x: 34, y: 200, width: 320, height: 22 },
      { ...name('Sticker'), type: 'shape', shape: 'burst', fill: brand.accent, x: 410, y: 60, width: 160, height: 160, rotation: -8 },
      { ...name('Sticker words'), type: 'text', text: '20%\noff', font: 'heading', size: 36, colour: brand.onAccent, align: 'center', x: 420, y: 104, width: 140, height: 80, lineHeight: 0.95, rotation: -8 },
    ],
  };
  const band: DesignDocInput = {
    width,
    height: DESIGN_SIZES.banner.height,
    background: brand.accent,
    layers: [
      { ...name('Small heading'), type: 'text', text: 'This week only', font: 'body', size: 13, weight: 600, colour: brand.onAccent, x: 34, y: 52, width: 300, height: 18, uppercase: true, letterSpacing: 1.5 },
      { ...name('Heading'), type: 'text', text: 'Late openings on Thursday', font: 'heading', size: 38, colour: brand.onAccent, x: 34, y: 80, width: 520, height: 60 },
      { ...name('Circle'), type: 'shape', shape: 'circle', fill: brand.deep, x: 500, y: -60, width: 180, height: 180, opacity: 0.25 },
    ],
  };
  return [
    { id: 'photo-header', label: 'Photo with heading', doc: DesignDoc.parse(photoHeader) },
    { id: 'offer', label: 'Offer sticker', doc: DesignDoc.parse(offer) },
    { id: 'band', label: 'Colour band', doc: DesignDoc.parse(band) },
  ];
}

/** An empty design of the given size. */
export function blankDesign(size: DesignSize, background = '#FFFFFF'): DesignDoc {
  const { width, height } = DESIGN_SIZES[size];
  return { version: 1, width, height, background, layers: [] };
}
