/**
 * Pictures for emails: reading a file's type and size, storing files where inboxes can load them,
 * and generating new pictures from a prompt.
 *
 * Storage and generation sit behind small interfaces, so the provider can change without touching
 * the rest. Without a bucket, files live in Postgres and the API serves them. Without an image
 * provider key, a sample generator makes soft colour pictures so the whole flow still works.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { assetBlobs, eq, type Db } from '@platform/db';
import { PlatformError } from './types.ts';

// ---------------------------------------------------------------- reading files

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp';
export const CONTENT_TYPES: Record<ImageType, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export const EXTENSIONS: Record<ImageType, string> = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' };

/** The type and size of a picture, read from its first bytes. Null when it is not one we know. */
export function imageInfo(data: Uint8Array): { type: ImageType; width: number; height: number } | null {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') {
    return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return { type: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { type: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { type: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the JPEG segments to the frame header, which holds the size.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        i += 2;
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { type: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Encodes RGB pixels as a PNG. Used for sample pictures and tests; real pictures come from providers. */
export function encodePng(width: number, height: number, rgb: Uint8Array) {
  const row = width * 3;
  const raw = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * row, row).copy(raw, y * (row + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- storing files

/** Where picture files live. Keys are unique per version, so files never change once written. */
export interface AssetStore {
  readonly name: string;
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;
  /** The address inboxes load the picture from. */
  url(key: string): string;
}

/** Keeps files in Postgres; the API serves them at /a/:key. No setup, fine until there are many. */
export class PgAssetStore implements AssetStore {
  readonly name = 'postgres';
  constructor(
    private readonly db: Db,
    private readonly publicUrl: string,
  ) {}

  async put(key: string, data: Uint8Array, contentType: string) {
    await this.db.insert(assetBlobs).values({ key, contentType, data: Buffer.from(data) }).onConflictDoNothing();
  }

  async get(key: string) {
    const [row] = await this.db.select().from(assetBlobs).where(eq(assetBlobs.key, key));
    return row ? { data: row.data, contentType: row.contentType } : null;
  }

  url(key: string) {
    return `${this.publicUrl.replace(/\/$/, '')}/a/${key}`;
  }
}

/** Keeps files in an S3 bucket, served from `publicBaseUrl` (CloudFront, or the bucket itself). */
export class S3AssetStore implements AssetStore {
  readonly name = 's3';
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly publicBaseUrl: string,
  ) {}

  static fromEnv(env: { AWS_REGION?: string; ASSETS_BUCKET?: string; ASSETS_PUBLIC_URL?: string }) {
    if (!env.ASSETS_BUCKET || !env.ASSETS_PUBLIC_URL) throw new Error('Set ASSETS_BUCKET and ASSETS_PUBLIC_URL together.');
    return new S3AssetStore(new S3Client({ region: env.AWS_REGION ?? 'eu-west-2' }), env.ASSETS_BUCKET, env.ASSETS_PUBLIC_URL);
  }

  async put(key: string, data: Uint8Array, contentType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: `a/${key}`, Body: data, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' }),
    );
  }

  async get(key: string) {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: `a/${key}` }));
      if (!out.Body) return null;
      return { data: Buffer.from(await out.Body.transformToByteArray()), contentType: out.ContentType ?? 'application/octet-stream' };
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  url(key: string) {
    return `${this.publicBaseUrl.replace(/\/$/, '')}/a/${key}`;
  }
}

// ---------------------------------------------------------------- generating pictures

/** Wide suits an email header; square and tall suit offers and social posts. */
export const IMAGE_SHAPES = ['wide', 'square', 'tall'] as const;
export type ImageShape = (typeof IMAGE_SHAPES)[number];

export const IMAGE_STYLES = {
  brand: { label: 'Your brand', words: 'A calm, premium photograph with soft natural light and gentle depth of field, styled with muted tones and small touches of the brand colour.' },
  photo: { label: 'Photo', words: 'A natural, realistic photograph with soft daylight and shallow depth of field.' },
  editorial: { label: 'Editorial', words: 'An editorial magazine photograph, considered composition, rich but restrained colour, fine detail.' },
  illustration: { label: 'Soft illustration', words: 'A soft hand-drawn illustration with gentle textures and a warm, friendly feel.' },
  flat: { label: 'Flat colour', words: 'A simple flat-colour graphic made of bold shapes, modern, with plenty of empty space.' },
} as const;
export type ImageStyle = keyof typeof IMAGE_STYLES;

/**
 * The prompt sent to the provider. Pictures never carry words: models spell badly, and headings
 * belong on the canvas or in the email where they can be edited and read by screen readers.
 */
export function imagePrompt(input: { prompt: string; style: ImageStyle; businessName: string; accent: string; shape: ImageShape }) {
  const room = input.shape === 'wide' ? 'Keep the left third calm and uncluttered, so a heading can sit over it.' : 'Leave some calm space for a few words to sit over it.';
  const colour = input.style === 'brand' || input.style === 'flat' ? ` Work in the colour ${input.accent} where it fits naturally.` : '';
  return [
    `${input.prompt.trim().replace(/\.?$/, '.')}`,
    IMAGE_STYLES[input.style].words + colour,
    `For an email from ${input.businessName}.`,
    room,
    'No text, letters, numbers, logos or watermarks.',
  ].join(' ');
}

export type GeneratedImage = { data: Buffer; contentType: string; width: number; height: number };

export interface ImageGenerator {
  readonly name: string;
  /** False for the sample generator, so the app can say its pictures are placeholders. */
  readonly real: boolean;
  generate(input: { prompt: string; shape: ImageShape; count: number; palette: string[] }): Promise<GeneratedImage[]>;
}

const OPENAI_SIZES: Record<ImageShape, { size: string; width: number; height: number }> = {
  wide: { size: '1536x1024', width: 1536, height: 1024 },
  square: { size: '1024x1024', width: 1024, height: 1024 },
  tall: { size: '1024x1536', width: 1024, height: 1536 },
};

/** OpenAI's image models. JPEG at medium quality keeps each picture small enough for email. */
export class OpenAIImageGenerator implements ImageGenerator {
  readonly name = 'openai';
  readonly real = true;
  constructor(
    private readonly apiKey: string,
    private readonly model = 'gpt-image-1',
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  async generate({ prompt, shape, count }: { prompt: string; shape: ImageShape; count: number }) {
    const { size, width, height } = OPENAI_SIZES[shape];
    const res = await this.doFetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt, n: count, size, quality: 'medium', output_format: 'jpeg', output_compression: 82, moderation: 'auto' }),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: { b64_json?: string }[]; error?: { code?: string; message?: string } };
    if (!res.ok) {
      const refused = body.error?.code === 'moderation_blocked' || body.error?.code === 'content_policy_violation';
      if (refused) throw new PlatformError('image_refused', 'The image service would not make that picture. Try describing it another way.', 422);
      throw new PlatformError('image_failed', 'The image service did not answer properly. Try again in a minute.', 502);
    }
    return (body.data ?? [])
      .filter((d): d is { b64_json: string } => typeof d.b64_json === 'string')
      .map((d) => ({ data: Buffer.from(d.b64_json, 'base64'), contentType: 'image/jpeg', width, height }));
  }
}

const SAMPLE_SIZES: Record<ImageShape, [number, number]> = { wide: [720, 480], square: [560, 560], tall: [480, 720] };

function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Soft-focus colour pictures made from the brand palette, with no provider. They stand in until an
 * image provider key is set, and keep tests and local work free and offline.
 */
export class SampleImageGenerator implements ImageGenerator {
  readonly name = 'sample';
  readonly real = false;

  async generate({ prompt, shape, count, palette }: { prompt: string; shape: ImageShape; count: number; palette: string[] }) {
    const [width, height] = SAMPLE_SIZES[shape];
    const colours = (palette.length ? palette : ['#3A2C8C', '#C9BFF2', '#F4F1EA']).map(rgbOf);
    return Array.from({ length: count }, (_, n) => {
      const seed = createHash('sha256').update(`${prompt}#${n}`).digest();
      const [dark, light, cream] = [colours[0]!, colours[1 % colours.length]!, colours[2 % colours.length]!];
      // A light source somewhere on the right, falling off into the dark colour.
      const lx = width * (0.55 + (seed[0]! / 255) * 0.35);
      const ly = height * (0.15 + (seed[1]! / 255) * 0.5);
      const reach = Math.hypot(width, height) * (0.45 + (seed[2]! / 255) * 0.25);
      const pixels = new Uint8Array(width * height * 3);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const d = Math.min(1, Math.hypot(x - lx, y - ly) / reach);
          const glow = (1 - d) ** 2;
          const mid = Math.max(0, 1 - Math.abs(d - 0.45) * 2.4) * 0.5;
          const grain = ((x * 7 + y * 13 + seed[3]!) % 9) - 4;
          const i = (y * width + x) * 3;
          for (let c = 0; c < 3; c++) {
            const value = dark[c]! * Math.max(0, 1 - glow - mid) + cream[c]! * glow + light[c]! * mid + grain;
            pixels[i + c] = Math.max(0, Math.min(255, Math.round(value)));
          }
        }
      }
      return { data: encodePng(width, height, pixels), contentType: 'image/png', width, height };
    });
  }
}
