import { blankDesign } from '@platform/content';
import { afterEach, describe, expect, it } from 'vitest';
import { encodePng, imageInfo, imagePrompt, OpenAIImageGenerator, PlatformError } from '../src/index.ts';
import { setup } from '../src/testing.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const png = (width = 4, height = 3) => encodePng(width, height, new Uint8Array(width * height * 3).fill(200));
const b64 = (data: Buffer) => data.toString('base64');

async function studio(config: { imagesPerDay?: number } = {}) {
  const ctx = await setup({ config });
  close = ctx.close;
  return ctx;
}

describe('reading pictures', () => {
  it('reads the type and size of PNG, JPEG, GIF and WebP files', () => {
    expect(imageInfo(png(40, 20))).toEqual({ type: 'png', width: 40, height: 20 });

    const gif = Buffer.from('GIF89a\x20\x00\x10\x00\x00\x00\x00', 'latin1');
    expect(imageInfo(gif)).toEqual({ type: 'gif', width: 32, height: 16 });

    // SOI, an APP0 segment, then a baseline frame header: precision, height 300, width 600.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageInfo(jpeg)).toEqual({ type: 'jpeg', width: 600, height: 300 });

    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBPVP8X', 8, 'ascii');
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(399, 27, 3);
    expect(imageInfo(webp)).toEqual({ type: 'webp', width: 800, height: 400 });

    expect(imageInfo(Buffer.from('not a picture at all, just words'))).toBeNull();
  });
});

describe('the picture library', () => {
  it('stores an upload and serves it from a public address', async () => {
    const { engine, tenant } = await studio();
    const asset = await engine.uploadAsset(tenant.id, { data: png(1200, 600), name: 'window.png' });
    expect(asset).toMatchObject({ kind: 'upload', name: 'window', width: 1200, height: 600, contentType: 'image/png' });
    expect(asset.url).toMatch(/^https:\/\/api\.test\/a\/ast_[a-z0-9]+-[0-9a-f]{8}\.png$/);

    const file = await engine.assetFile(asset.url.split('/a/')[1]!);
    expect(file?.contentType).toBe('image/png');
    expect(imageInfo(file!.data)).toMatchObject({ width: 1200, height: 600 });
    expect(await engine.assetFile('../../etc/passwd')).toBeNull();
    expect((await engine.listAssets(tenant.id)).map((a) => a.id)).toEqual([asset.id]);
  });

  it('turns away files inboxes cannot show', async () => {
    const { engine, tenant } = await studio();
    await expect(engine.uploadAsset(tenant.id, { data: Buffer.from('hello') })).rejects.toThrow('PNG, JPEG or GIF');
    const webp = Buffer.alloc(30);
    webp.write('RIFFxxxxWEBPVP8X', 0, 'ascii');
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(99, 27, 3);
    await expect(engine.uploadAsset(tenant.id, { data: webp })).rejects.toThrow('Outlook');
    await expect(engine.uploadAsset(tenant.id, { data: Buffer.alloc(6 * 1024 * 1024) })).rejects.toMatchObject({ status: 413 });
  });

  it('keeps a removed picture working in emails already sent', async () => {
    const { engine, tenant } = await studio();
    const asset = await engine.uploadAsset(tenant.id, { data: png() });
    await engine.deleteAsset(tenant.id, asset.id);
    expect(await engine.listAssets(tenant.id)).toEqual([]);
    expect(await engine.assetFile(asset.url.split('/a/')[1]!)).not.toBeNull();
  });
});

describe('generating pictures', () => {
  it('asks for a picture in the brand, with room for a heading and no words in it', () => {
    const prompt = imagePrompt({ prompt: 'A salon chair by a tall window', style: 'brand', shape: 'wide', businessName: 'Linden Studio', accent: '#5B49D6' });
    expect(prompt).toContain('A salon chair by a tall window.');
    expect(prompt).toContain('#5B49D6');
    expect(prompt).toContain('Linden Studio');
    expect(prompt).toContain('left third');
    expect(prompt).toContain('No text, letters, numbers, logos or watermarks.');
  });

  it('adds generated pictures to the library and stops at the daily limit', async () => {
    const { engine, tenant } = await studio({ imagesPerDay: 3 });
    const made = await engine.generateImages(tenant.id, { prompt: 'Dried flowers on a counter', count: 2 });
    expect(made).toHaveLength(2);
    expect(made[0]).toMatchObject({ kind: 'generated', prompt: 'Dried flowers on a counter', style: 'brand', provider: 'sample', width: 720, height: 480 });
    expect(made[0]!.url).not.toBe(made[1]!.url);

    expect(await engine.imageSettings(tenant.id)).toMatchObject({ provider: 'sample', real: false, perDay: 3, left: 1 });
    await expect(engine.generateImages(tenant.id, { prompt: 'Another one', count: 2 })).rejects.toThrow('1 more picture today');
    await expect(engine.generateImages(tenant.id, { prompt: 'no' })).rejects.toThrow('Describe the picture');
  });

  it('calls OpenAI for a wide JPEG and explains a refusal', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const ok = new OpenAIImageGenerator('sk-test', 'gpt-image-1', async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ data: [{ b64_json: b64(png()) }] });
    });
    const [picture] = await ok.generate({ prompt: 'A chair', shape: 'wide', count: 1 });
    expect(calls[0]).toMatchObject({ url: 'https://api.openai.com/v1/images/generations', body: { model: 'gpt-image-1', size: '1536x1024', n: 1, output_format: 'jpeg' } });
    expect(picture).toMatchObject({ width: 1536, height: 1024 });

    const refused = new OpenAIImageGenerator('sk-test', 'gpt-image-1', async () => Response.json({ error: { code: 'moderation_blocked' } }, { status: 400 }));
    const error = await refused.generate({ prompt: 'x', shape: 'square', count: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    expect(error).toMatchObject({ code: 'image_refused', status: 422 });
  });
});

describe('designs', () => {
  it('saves the layers with the picture, and a new version gets a new file', async () => {
    const { engine, tenant } = await studio();
    const design = { ...blankDesign('header', '#2D2470'), layers: [{ id: 'l1', type: 'text' as const, text: 'Thursday has space', size: 40, colour: '#FFFFFF', x: 30, y: 90, width: 300, height: 90 }] };
    const first = await engine.createDesign(tenant.id, { name: 'Thursday header', design, png: b64(png(1200, 600)) });
    expect(first).toMatchObject({ kind: 'design', name: 'Thursday header', width: 1200, height: 600 });
    expect(first.design).toMatchObject({ width: 600, height: 300, layers: [{ text: 'Thursday has space', font: 'heading', align: 'left' }] });

    const second = await engine.updateDesign(tenant.id, first.id, { name: 'Thursday header', design: { ...design, background: '#000000' }, png: b64(png(1200, 600)) });
    expect(second.id).toBe(first.id);
    expect(second.url).not.toBe(first.url);
    expect(await engine.assetFile(first.url.split('/a/')[1]!)).not.toBeNull();

    await expect(engine.createDesign(tenant.id, { design: { ...design, background: 'red' }, png: b64(png()) })).rejects.toThrow('design.background');
    const upload = await engine.uploadAsset(tenant.id, { data: png() });
    await expect(engine.updateDesign(tenant.id, upload.id, { design, png: b64(png()) })).rejects.toThrow('Only designs');
  });
});
