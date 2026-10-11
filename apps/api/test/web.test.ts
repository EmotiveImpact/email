import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { pagePolicy, site } from '../src/web.ts';

function build() {
  const dist = mkdtempSync(join(tmpdir(), 'web-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dist, 'favicon.svg'), '<svg/>');
  return dist;
}

function sample() {
  const api = new Hono();
  api.get('/health', (c) => c.json({ ok: true }));
  api.get('/v1/emails/:id', (c) => c.json({ error: { code: 'unauthorised' } }, 401));
  return site(api, { https: true, dist: build(), embedOrigins: async () => ['https://app.saleane.com'] });
}

describe('serving the web app and the API from one origin', () => {
  it('serves app pages with the page itself never cached and a strict policy', async () => {
    const app = sample();
    const page = await app.request('/ten_123/campaigns');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="root"');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'self' https://app.saleane.com");
    expect(page.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('caches hashed files for a year and serves top-level files', async () => {
    const app = sample();
    const asset = await app.request('/assets/index-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await app.request('/favicon.svg')).status).toBe(200);
  });

  it('leaves API paths to the API, including its own not-found answers', async () => {
    const app = sample();
    expect(await (await app.request('/health')).json()).toEqual({ ok: true });
    const v1 = await app.request('/v1/emails/msg_1');
    expect(v1.status).toBe(401);
    const missing = await app.request('/v1/nothing-here');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('keeps scripts to our own origin', () => {
    expect(pagePolicy([])).toContain("script-src 'self'");
    expect(pagePolicy([])).toContain("frame-ancestors 'self'");
  });
});
