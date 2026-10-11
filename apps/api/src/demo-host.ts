/**
 * A stand-in for Saleane, to try the embedded studio locally: `pnpm demo:host`, then open
 * http://localhost:3000. Its "server" creates a studio session with Saleane's API key, the same
 * call Saleane makes for real, and its page mounts the studio in an iframe.
 *
 * Needs SALEANE_API_KEY (printed by `pnpm db:seed`) and the API and web app running.
 */
import { createServer } from 'node:http';
import { PlatformClient } from '@platform/sdk';

const apiKey = process.env.SALEANE_API_KEY;
if (!apiKey) throw new Error('Set SALEANE_API_KEY to the Saleane key printed by pnpm db:seed.');
const client = new PlatformClient({ apiKey, baseUrl: process.env.API_URL ?? 'http://localhost:8787' });
const ORIGIN = 'http://localhost:3000';

// Saleane's look: ivory, sage and a serif.
const theme = { accent: '#5E7D63', headingFont: 'serif', canvas: '#F6F1E7' } as const;

const page = (studioUrl: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Saleane · Email</title>
<style>
  body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#F6F1E7;color:#2B2A26;display:flex;min-height:100vh}
  aside{width:220px;flex-shrink:0;padding:28px 18px;border-right:1px solid #E6DFD0;display:flex;flex-direction:column;gap:4px}
  aside b{font:600 24px/1 Georgia,serif;margin:0 10px 26px;color:#3F5A45}
  aside a{padding:9px 12px;border-radius:10px;color:#5B5850;text-decoration:none}
  aside a.on{background:#E4EBDF;color:#2F4634;font-weight:600}
  main{flex:1;min-width:0;padding:24px 28px}
  h1{font:400 30px/1.1 Georgia,serif;margin:0 0 4px}
  p{margin:0 0 18px;color:#77736A}
  #studio{border-radius:16px;overflow:hidden}
</style></head><body>
<aside><b>Saleane</b><a>Diary</a><a>Clients</a><a>Services</a><a class="on">Email</a><a>Reports</a><a>Settings</a></aside>
<main><h1>Email</h1><p>Newsletters to your clients, sent from Linden Studio.</p><div id="studio"></div></main>
<script type="module">
  // The same steps as mountStudio in @platform/sdk.
  const url = ${JSON.stringify(studioUrl)};
  const frame = Object.assign(document.createElement('iframe'), { src: url, title: 'Email' });
  Object.assign(frame.style, { width: '100%', border: '0', display: 'block', minHeight: '640px' });
  document.getElementById('studio').append(frame);
  addEventListener('message', (e) => {
    if (e.origin !== new URL(url).origin || e.data?.source !== 'platform-studio') return;
    if (e.data.type === 'resize') frame.style.height = Math.max(e.data.height, 640) + 'px';
    // A real host would ask its server for a fresh session here; the stand-in offers a reload.
    if (e.data.type === 'session-expired') frame.replaceWith(Object.assign(document.createElement('button'), { textContent: 'Open Email again', onclick: () => location.reload() }));
    console.log('studio:', e.data.type);
  });
</script></body></html>`;

createServer(async (req, res) => {
  if (req.url !== '/') return res.writeHead(404).end();
  try {
    await client.studio.setOrigins([ORIGIN]);
    const { url } = await client.studio.createSession({
      tenant: 'linden',
      origin: ORIGIN,
      user: { id: 'staff-maya', name: 'Maya', email: 'maya@linden.example' },
      theme,
    });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(url));
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error));
  }
}).listen(3000, () => console.log(`Saleane stand-in on ${ORIGIN}`));
