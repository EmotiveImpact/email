/**
 * Production: the API also serves the built web app, so both share one origin (D30) and sign-in
 * cookies stay first-party. Hashed files are cached for a year; the page itself never is, so a
 * deploy shows up on the next load.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type MiddlewareHandler } from 'hono';

/** Paths the API answers. Anything else is a page of the web app. */
const API_PREFIXES = ['/v1', '/app', '/auth', '/ses', '/u/', '/a/', '/billing/', '/health', '/ready'];
const isApi = (path: string) => API_PREFIXES.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));

/** Headers every response gets. HSTS only once the site is served over HTTPS. */
export function securityHeaders({ https }: { https: boolean }): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'strict-origin-when-cross-origin');
    c.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (https) c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  };
}

/**
 * The page's Content-Security-Policy. Pictures can come from anywhere over HTTPS (people paste
 * links to their own photos); scripts, styles and API calls only from here. Only the host apps that
 * registered an embed origin may frame the app (the studio inside Saleane, say).
 */
export function pagePolicy(frameAncestors: string[]) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // React and the editor set inline styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${["'self'", ...frameAncestors].join(' ')}`,
  ].join('; ');
}

export function webApp(options: { dist: string; embedOrigins: () => Promise<string[]> }) {
  const web = new Hono();
  let page: string | null = null;
  let origins: { list: string[]; at: number } = { list: [], at: 0 };

  async function frameAncestors() {
    // Re-read the registered origins at most once a minute.
    if (Date.now() - origins.at > 60_000) origins = { list: await options.embedOrigins().catch(() => origins.list), at: Date.now() };
    return origins.list;
  }

  const assets = serveStatic({ root: options.dist });
  web.use('/assets/*', async (c, next) => {
    const res = await assets(c, next);
    // File names carry a hash of their contents, so a file never changes under the same name.
    if (res?.status === 200) res.headers.set('cache-control', 'public, max-age=31536000, immutable');
    return res;
  });
  // Fonts, icons and other files at the top level of the build.
  web.use('*', async (c, next) => (isApi(c.req.path) || c.req.path === '/' ? next() : serveStatic({ root: options.dist })(c, next)));

  web.get('*', async (c, next) => {
    if (isApi(c.req.path)) return next();
    page ??= await readFile(join(options.dist, 'index.html'), 'utf8');
    return c.html(page, 200, { 'cache-control': 'no-cache', 'content-security-policy': pagePolicy(await frameAncestors()) });
  });
  return web;
}

/** The whole site: security headers, the web app when a build is given, then the API. */
export function site(api: Hono<any>, options: { https: boolean; dist?: string; embedOrigins: () => Promise<string[]> }) {
  const root = new Hono();
  root.use(securityHeaders({ https: options.https }));
  if (options.dist) root.route('/', webApp({ dist: options.dist, embedOrigins: options.embedOrigins }));
  root.route('/', api);
  root.notFound((c) => c.json({ error: { code: 'not_found', message: 'Nothing here.' } }, 404));
  return root;
}

