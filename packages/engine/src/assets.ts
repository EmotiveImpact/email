/**
 * A business's picture library: uploads, generated pictures and canvas designs. Every picture is
 * checked (type, size), stored once under a key that never changes, and shown in emails by URL.
 */
import { randomBytes } from 'node:crypto';
import { brandShades, DesignDoc } from '@platform/content';
import { and, assets, desc, eq, gte, isNull, newId, sql, tenants, type AssetKind, type Db } from '@platform/db';
import { z } from 'zod';
import {
  CONTENT_TYPES,
  EXTENSIONS,
  IMAGE_SHAPES,
  IMAGE_STYLES,
  imageInfo,
  imagePrompt,
  type AssetStore,
  type ImageGenerator,
  type ImageStyle,
} from './images.ts';
import { PlatformError } from './types.ts';

type Asset = typeof assets.$inferSelect;
type Tenant = typeof tenants.$inferSelect;

/** Large enough for a good photo, small enough that emails still load quickly. */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
/** Over this, the library suggests a smaller file: some inboxes clip heavy emails. */
export const HEAVY_ASSET_BYTES = 1024 * 1024;
const MAX_SIDE = 4000;

export const GenerateImagesInput = z.object({
  prompt: z.string().trim().min(3, 'Describe the picture in a few words.').max(1000),
  style: z.enum(Object.keys(IMAGE_STYLES) as [ImageStyle, ...ImageStyle[]]).default('brand'),
  shape: z.enum(IMAGE_SHAPES).default('wide'),
  count: z.number().int().min(1).max(4).default(2),
});
export type GenerateImagesInput = z.input<typeof GenerateImagesInput>;

export const SaveDesignInput = z.object({
  name: z.string().trim().min(1).max(120).default('Design'),
  design: DesignDoc,
  /** The design drawn as a PNG, base64, at twice its size. */
  png: z.string().min(10).max(Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 100),
});
export type SaveDesignInput = z.input<typeof SaveDesignInput>;

export type AssetDeps = {
  db: Db;
  store: AssetStore;
  generator: ImageGenerator;
  /** Generated pictures a business may make each day. They cost money; this caps a runaway loop. */
  imagesPerDay: number;
  /** The plan's monthly allowance for businesses that pay us (D98). Null when an app pays. */
  picturesLeft?: (tenantId: string, now: Date) => Promise<{ limit: number; left: number; resets: Date } | null>;
};

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  throw new PlatformError('invalid_request', `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`, 422);
}

const startOfDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export function createAssets({ db, store, generator, imagesPerDay, picturesLeft }: AssetDeps) {
  function view(row: Asset) {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      url: store.url(row.key),
      contentType: row.contentType,
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      heavy: row.bytes > HEAVY_ASSET_BYTES,
      prompt: row.prompt,
      style: row.style,
      provider: row.provider,
      design: row.design,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  type AssetView = ReturnType<typeof view>;

  async function tenantById(tenantId: string): Promise<Tenant> {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw new PlatformError('not_found', 'No such business.', 404);
    return tenant;
  }

  /** Checks a file is a picture an inbox can show, and returns what we store about it. */
  function inspect(data: Uint8Array) {
    if (data.byteLength === 0) throw new PlatformError('invalid_request', 'The file is empty.', 422);
    if (data.byteLength > MAX_ASSET_BYTES) throw new PlatformError('too_large', 'Pictures can be up to 5 MB. Try a smaller or more compressed file.', 413);
    const info = imageInfo(data);
    if (!info) throw new PlatformError('invalid_request', 'Use a PNG, JPEG or GIF picture.', 422);
    // WebP looks fine in Gmail and Apple Mail, but Outlook on Windows shows nothing.
    if (info.type === 'webp') throw new PlatformError('invalid_request', 'Outlook cannot show WebP pictures. Save it as JPEG or PNG and try again.', 422);
    if (!info.width || !info.height || info.width > MAX_SIDE || info.height > MAX_SIDE) {
      throw new PlatformError('invalid_request', `Pictures can be up to ${MAX_SIDE} pixels on each side.`, 422);
    }
    return info;
  }

  async function store1(tenantId: string, data: Uint8Array, fields: Omit<typeof assets.$inferInsert, 'id' | 'tenantId' | 'key' | 'contentType' | 'width' | 'height' | 'bytes'>, id = newId('ast')) {
    const info = inspect(data);
    const key = `${id}-${randomBytes(4).toString('hex')}.${EXTENSIONS[info.type]}`;
    await store.put(key, data, CONTENT_TYPES[info.type]);
    return { id, tenantId, key, contentType: CONTENT_TYPES[info.type], width: info.width, height: info.height, bytes: data.byteLength, ...fields };
  }

  async function listAssets(tenantId: string, kind?: AssetKind) {
    const rows = await db
      .select()
      .from(assets)
      .where(and(eq(assets.tenantId, tenantId), isNull(assets.deletedAt), kind ? eq(assets.kind, kind) : undefined))
      .orderBy(desc(assets.updatedAt))
      .limit(300);
    return rows.map(view);
  }

  async function getAsset(tenantId: string, assetId: string) {
    const [row] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.tenantId, tenantId), isNull(assets.deletedAt)));
    if (!row) throw new PlatformError('not_found', 'No such picture.', 404);
    return row;
  }

  async function uploadAsset(tenantId: string, input: { data: Uint8Array; name?: string; createdBy?: string }) {
    await tenantById(tenantId);
    const name = (input.name ?? '').replace(/\.[a-z0-9]{2,4}$/i, '').trim().slice(0, 120) || 'Picture';
    const values = await store1(tenantId, input.data, { kind: 'upload', name, createdBy: input.createdBy });
    const [row] = await db.insert(assets).values(values).returning();
    return view(row!);
  }

  async function generatedToday(tenantId: string, now: Date) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(assets)
      .where(and(eq(assets.tenantId, tenantId), eq(assets.kind, 'generated'), gte(assets.createdAt, startOfDay(now))));
    return row?.n ?? 0;
  }

  /** Whichever is tighter: the plan's month, or the daily cap. */
  async function allowance(tenantId: string, now: Date) {
    const [today, month] = await Promise.all([generatedToday(tenantId, now), picturesLeft?.(tenantId, now) ?? null]);
    const day = { per: 'day' as const, limit: imagesPerDay, left: Math.max(0, imagesPerDay - today) };
    return month && month.left <= day.left ? { per: 'month' as const, limit: month.limit, left: month.left, resets: month.resets } : day;
  }

  async function imageSettings(tenantId: string, now = new Date()) {
    const { per, limit, left } = await allowance(tenantId, now);
    return {
      provider: generator.name,
      real: generator.real,
      per,
      limit,
      left,
      styles: Object.entries(IMAGE_STYLES).map(([id, s]) => ({ id, label: s.label })),
    };
  }

  /** Makes pictures from a prompt in the business's colours and adds them to its library. */
  async function generateImages(tenantId: string, raw: unknown, createdBy?: string, now = new Date()): Promise<AssetView[]> {
    const input = parse(GenerateImagesInput, raw);
    const tenant = await tenantById(tenantId);
    const limit = await allowance(tenantId, now);
    if (limit.left < input.count) {
      const when = limit.per === 'day' ? 'today' : 'this month';
      const more =
        limit.per === 'day'
          ? 'More tomorrow.'
          : `More on ${limit.resets.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })}, or choose a bigger plan.`;
      throw new PlatformError(
        'limit_reached',
        limit.left > 0
          ? `You can make ${limit.left} more ${limit.left === 1 ? 'picture' : 'pictures'} ${when}.`
          : `That is all the pictures for ${when}. ${more}`,
        429,
      );
    }
    const shades = brandShades(tenant.name, tenant.brand?.accent);
    const prompt = imagePrompt({ prompt: input.prompt, style: input.style, shape: input.shape, businessName: tenant.name, accent: shades.accent });
    const pictures = await generator.generate({ prompt, shape: input.shape, count: input.count, palette: [shades.deep, shades.accent, shades.tint] });
    if (!pictures.length) throw new PlatformError('image_failed', 'No pictures came back. Try again.', 502);
    const name = input.prompt.replace(/\s+/g, ' ').slice(0, 60);
    const values = await Promise.all(
      pictures.map((p) => store1(tenantId, p.data, { kind: 'generated', name, prompt: input.prompt, style: input.style, provider: generator.name, createdBy })),
    );
    const rows = await db.insert(assets).values(values).returning();
    return rows.map(view);
  }

  function decodePng(base64: string) {
    const data = Buffer.from(base64.replace(/^data:image\/png;base64,/, ''), 'base64');
    if (imageInfo(data)?.type !== 'png') throw new PlatformError('invalid_request', 'The design picture must be a PNG.', 422);
    return data;
  }

  /** Saves a canvas design: its layers, and the picture drawn from them. */
  async function createDesign(tenantId: string, raw: unknown, createdBy?: string) {
    await tenantById(tenantId);
    const input = parse(SaveDesignInput, raw);
    const values = await store1(tenantId, decodePng(input.png), { kind: 'design', name: input.name, design: input.design, createdBy });
    const [row] = await db.insert(assets).values(values).returning();
    return view(row!);
  }

  /**
   * A new version of a design. It gets a new file, so emails already sent keep the old picture and
   * new emails show the new one.
   */
  async function updateDesign(tenantId: string, assetId: string, raw: unknown) {
    const existing = await getAsset(tenantId, assetId);
    if (existing.kind !== 'design') throw new PlatformError('invalid_request', 'Only designs can be changed. Make a design from this picture instead.', 422);
    const input = parse(SaveDesignInput, raw);
    const { id: _id, tenantId: _t, ...file } = await store1(tenantId, decodePng(input.png), { kind: 'design', name: input.name, design: input.design }, existing.id);
    const [row] = await db
      .update(assets)
      .set({ ...file, updatedAt: new Date() })
      .where(eq(assets.id, existing.id))
      .returning();
    return view(row!);
  }

  async function renameAsset(tenantId: string, assetId: string, name: unknown) {
    const clean = String(name ?? '').trim().slice(0, 120);
    if (!clean) throw new PlatformError('invalid_request', 'Give the picture a name.', 422);
    await getAsset(tenantId, assetId);
    const [row] = await db.update(assets).set({ name: clean, updatedAt: new Date() }).where(eq(assets.id, assetId)).returning();
    return view(row!);
  }

  /** Takes a picture out of the library. Its file stays, so emails already sent still show it. */
  async function deleteAsset(tenantId: string, assetId: string) {
    await getAsset(tenantId, assetId);
    await db.update(assets).set({ deletedAt: new Date() }).where(eq(assets.id, assetId));
  }

  /** The file behind a public picture URL. */
  async function assetFile(key: string) {
    if (!/^ast_[a-z0-9]+-[0-9a-f]{8}\.(png|jpg|gif)$/i.test(key)) return null;
    return store.get(key);
  }

  return { listAssets, uploadAsset, generateImages, imageSettings, createDesign, updateDesign, renameAsset, deleteAsset, assetFile };
}
