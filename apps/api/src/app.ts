import { and, eq, messages, sql, tenants, type Db } from '@platform/db';
import {
  isSnsUrl,
  LIMITS,
  PlatformError,
  verifySnsMessage,
  WEBHOOK_EVENTS,
  type Engine,
  type SnsMessage,
  type WebhookEvent,
} from '@platform/engine';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { Auth } from './auth.ts';
import { dashboardRoutes, publicMessage } from './dashboard.ts';

type App = Awaited<ReturnType<Engine['authenticate']>>;

const tooLarge = (): never => {
  throw new PlatformError('too_large', 'That request is too large.', 413);
};

/**
 * The caller's IP address. Behind the load balancer it is the last address in X-Forwarded-For,
 * the one the balancer added; earlier entries come from the client and cannot be trusted.
 */
export function clientIp(headers: Headers) {
  const forwarded = headers.get('x-forwarded-for');
  return forwarded?.split(',').pop()?.trim() || 'direct';
}
type Env = { Variables: { app: App } };

export type ApiOptions = {
  engine: Engine;
  db: Db;
  /** Origin of the web app, allowed to call /app/*. */
  webOrigin: string;
  /** Only accept SES events from this SNS topic. */
  sesTopicArn?: string;
  /** Sign-in for the web app. */
  auth: Auth;
  verifySns?: (m: SnsMessage) => Promise<boolean>;
  fetch?: typeof fetch;
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string) {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F2F1EE;color:#121214;font:16px/1.5 system-ui,sans-serif}
main{max-width:420px;margin:24px;padding:32px;background:#fff;border:1px solid #ECEBE8;border-radius:18px}h1{font-size:22px;margin:0 0 8px}p{margin:0 0 20px;color:#55555c}
button{font:inherit;font-weight:600;padding:10px 18px;border:0;border-radius:999px;background:#121214;color:#fff;cursor:pointer}</style></head>
<body><main>${body}</main></body></html>`;
}

export function createApi(options: ApiOptions) {
  const { engine, db } = options;
  const verify = options.verifySns ?? ((m: SnsMessage) => verifySnsMessage(m, options.fetch));
  const api = new Hono<Env>();

  api.onError((error, c) => {
    if (error instanceof PlatformError) {
      if (error.details.retryAfter) c.header('Retry-After', String(error.details.retryAfter));
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    if (error instanceof HTTPException) return error.getResponse();
    console.error(error);
    return c.json({ error: { code: 'internal_error', message: 'Something went wrong on our side.' } }, 500);
  });

  const body = async (c: { req: { json: () => Promise<unknown> } }) => {
    try {
      return await c.req.json();
    } catch {
      throw new PlatformError('invalid_json', 'The request body must be JSON.', 400);
    }
  };

  // Liveness: the process answers. Readiness: it can reach the database too.
  api.get('/health', (c) => c.json({ ok: true }));
  api.get('/ready', async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  // ------------------------------------------------------------------ public API, /v1

  const v1 = new Hono<Env>();
  v1.use(async (c, next) => {
    const header = c.req.header('authorization');
    const key = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const app = await engine.authenticate(key);
    await engine.hitLimit(`app:${app.id}`, LIMITS.apiKey);
    c.set('app', app);
    await next();
  });
  // Emails can carry a large HTML body; nothing else needs more than a megabyte.
  v1.use(async (c, next) => bodyLimit({ maxSize: c.req.path.endsWith('/emails') ? 6 * 1024 * 1024 : 1024 * 1024, onError: tooLarge })(c, next));

  v1.put('/tenants/:externalId', async (c) => {
    // The SES tenant is ours to assign, one per business, so apps cannot share or dodge a reputation.
    const { sesTenant: _ignored, ...input } = (await body(c)) as Record<string, unknown>;
    const tenant = await engine.upsertTenant(c.var.app.id, c.req.param('externalId'), input as never);
    return c.json(publicTenant(tenant));
  });

  v1.post('/emails', async (c) => {
    const input = (await body(c)) as Record<string, unknown>;
    const idempotencyKey = c.req.header('idempotency-key');
    const message = await engine.sendEmail(c.var.app, { ...(input as object), ...(idempotencyKey && { idempotencyKey }) } as never);
    return c.json(publicMessage(message), 202);
  });

  v1.get('/emails/:id', async (c) => {
    const [row] = await db
      .select({ message: messages })
      .from(messages)
      .innerJoin(tenants, eq(tenants.id, messages.tenantId))
      .where(and(eq(messages.id, c.req.param('id')), eq(tenants.appId, c.var.app.id)));
    if (!row) throw new PlatformError('not_found', 'No email with that id.', 404);
    return c.json(publicMessage(row.message));
  });

  v1.put('/contacts', async (c) => {
    const contact = await engine.upsertContact(c.var.app, (await body(c)) as never);
    return c.json({
      id: contact.id,
      email: contact.email,
      externalId: contact.externalId,
      firstName: contact.firstName,
      lastName: contact.lastName,
      attributes: contact.attributes,
      marketingConsent: contact.marketingConsent,
    });
  });

  // Removes a client and everything personal about them (UK GDPR erasure). Their address stays
  // suppressed if it bounced or unsubscribed, so it is never emailed again by mistake.
  v1.post('/contacts/erase', async (c) => c.json(await engine.eraseContact(c.var.app, await body(c))));

  // The diary: bookings and free time from your booking system. Flows use them to time emails.
  v1.put('/appointments', async (c) => {
    const row = await engine.upsertAppointment(c.var.app, await body(c));
    return c.json({
      id: row.externalId,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      service: row.service,
      staff: row.staff,
      price: row.price,
      currency: row.currency,
      status: row.status,
      bookedAt: row.bookedAt,
    });
  });

  v1.post('/appointments/batch', async (c) => c.json(await engine.upsertAppointments(c.var.app, await body(c))));

  v1.put('/availability', async (c) => c.json(await engine.setAvailability(c.var.app, await body(c))));

  v1.post('/events', async (c) => {
    const event = await engine.recordEvent(c.var.app, (await body(c)) as never);
    return c.json({ id: event.id, name: event.name, matchedContact: Boolean(event.contactId) }, 202);
  });

  v1.post('/webhooks', async (c) => {
    const input = (await body(c)) as { url?: string; events?: string[] };
    const events = (input.events ?? []).filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e));
    const endpoint = await engine.addWebhookEndpoint(c.var.app.id, String(input.url ?? ''), events);
    return c.json({ id: endpoint.id, secret: endpoint.secret, events }, 201);
  });
  v1.get('/webhooks', async (c) => c.json(await engine.listWebhookEndpoints(c.var.app.id)));
  v1.delete('/webhooks/:id', async (c) => {
    await engine.removeWebhookEndpoint(c.var.app.id, c.req.param('id'));
    return c.body(null, 204);
  });

  // Sending domains. A business sends from the platform address until its own domain is verified.
  v1.get('/tenants/:externalId/domains', async (c) => {
    const tenant = await engine.getTenant(c.var.app.id, c.req.param('externalId'));
    return c.json(await engine.listDomains(tenant.id));
  });

  v1.post('/tenants/:externalId/domains', async (c) => {
    const tenant = await engine.getTenant(c.var.app.id, c.req.param('externalId'));
    return c.json(await engine.addDomain(tenant.id, ((await body(c)) as { domain?: unknown }).domain), 201);
  });

  v1.post('/tenants/:externalId/domains/:domainId/check', async (c) => {
    const tenant = await engine.getTenant(c.var.app.id, c.req.param('externalId'));
    return c.json(await engine.checkTenantDomain(tenant.id, c.req.param('domainId')));
  });

  v1.delete('/tenants/:externalId/domains/:domainId', async (c) => {
    const tenant = await engine.getTenant(c.var.app.id, c.req.param('externalId'));
    await engine.removeDomain(tenant.id, c.req.param('domainId'));
    return c.body(null, 204);
  });

  /** Which web origins may show the embedded studio. Replaces the list. */
  v1.put('/studio/origins', async (c) => c.json({ origins: await engine.setEmbedOrigins(c.var.app.id, await body(c)) }));

  /**
   * Opens the studio for one business and one person. Call it from your server, then load `url`
   * in an iframe straight away: the link works once, within five minutes.
   */
  v1.post('/studio/sessions', async (c) => {
    const input = (await body(c)) as { page?: unknown };
    const { launchToken, expiresAt } = await engine.createStudioSession(c.var.app, input);
    const page = input.page === 'audience' || input.page === 'flows' ? input.page : 'campaigns';
    return c.json({ url: `${options.webOrigin}/embed?page=${page}#token=${launchToken}`, expiresAt }, 201);
  });

  api.route('/v1', v1);

  // ------------------------------------------------------------------ SES events via SNS

  api.post('/ses/events', async (c) => {
    // SNS posts JSON with a text/plain content type.
    let message: SnsMessage;
    try {
      message = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: { code: 'invalid_json', message: 'Expected an SNS message.' } }, 400);
    }
    if (options.sesTopicArn && message.TopicArn !== options.sesTopicArn) return c.json({ error: { code: 'wrong_topic', message: 'Unexpected topic.' } }, 403);
    if (!(await verify(message))) return c.json({ error: { code: 'bad_signature', message: 'SNS signature did not verify.' } }, 403);

    if (message.Type === 'SubscriptionConfirmation') {
      if (!message.SubscribeURL || !isSnsUrl(message.SubscribeURL)) return c.json({ error: { code: 'bad_subscribe_url', message: 'Unexpected subscribe URL.' } }, 400);
      await (options.fetch ?? fetch)(message.SubscribeURL);
      return c.json({ confirmed: true });
    }
    if (message.Type !== 'Notification') return c.json({ ignored: message.Type });
    return c.json(await engine.ingestSesEvent(message.Message));
  });

  // ------------------------------------------------------------------ unsubscribe (RFC 8058)

  api.get('/u/:token', async (c) => {
    // A page with a button, so link scanners that follow GETs cannot unsubscribe anyone.
    const action = escapeHtml(c.req.path);
    const target = await engine.unsubscribeTarget(c.req.param('token')).catch(() => null);
    if (!target) return c.html(page('Unsubscribe', '<h1>This link is not valid</h1><p>It may have been copied only in part. Use the unsubscribe link at the foot of the latest email.</p>'), 404);
    const { tenantName, email } = target;
    return c.html(
      page(
        'Unsubscribe',
        `<h1>Stop emails from ${escapeHtml(tenantName)}?</h1><p>${escapeHtml(email)} will stop getting news and offers from ${escapeHtml(tenantName)}. Booking reminders and receipts still arrive.</p>
<form method="post" action="${action}"><button type="submit">Unsubscribe</button></form>`,
      ),
    );
  });

  api.post('/u/:token', async (c) => {
    const { tenantName, email } = await engine.unsubscribe(c.req.param('token'));
    return c.html(page('Unsubscribed', `<h1>You are unsubscribed</h1><p>${escapeHtml(email)} will not get news from ${escapeHtml(tenantName)} again.</p>`));
  });

  // ------------------------------------------------------------------ pictures in emails

  /** Picture files, when they live in Postgres. Keys change with every version, so cache forever. */
  api.get('/a/:key', async (c) => {
    const file = await engine.assetFile(c.req.param('key'));
    if (!file) return c.text('Not found', 404);
    return c.body(new Uint8Array(file.data), 200, {
      'content-type': file.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      // The design canvas draws pictures into a <canvas> and saves it; that needs CORS.
      'access-control-allow-origin': '*',
    });
  });

  // ------------------------------------------------------------------ Stripe

  /** Stripe's webhooks. The signature is checked against the raw body, so read it as text. */
  api.post('/billing/stripe', async (c) => c.json(await engine.stripeWebhook(await c.req.text(), c.req.header('stripe-signature'))));

  // ------------------------------------------------------------------ booking systems (D132)

  /**
   * Square sends the owner back here after they grant (or refuse) access. The code is finished from
   * the web app, where the owner is signed in, so the grant always lands on their own business.
   */
  api.get('/connect/square/callback', (c) => {
    const state = c.req.query('state') ?? '';
    const tenantId = engine.connectReturnTenant(state);
    if (!tenantId) return c.html(page('Link expired', '<h1>This link has expired</h1><p>Start connecting Square again from your settings.</p>'), 400);
    const target = new URL(`${options.webOrigin}/${encodeURIComponent(tenantId)}/settings/diary`);
    const code = c.req.query('code');
    if (code) {
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
    } else {
      target.searchParams.set('refused', '1');
    }
    return c.redirect(target.toString(), 302);
  });

  /** Square's booking webhooks. The signature covers the raw body, so read it as text. */
  api.post('/connect/square/webhook', async (c) => c.json(await engine.squareWebhook(await c.req.text(), c.req.header('x-square-hmacsha256-signature'))));

  // ------------------------------------------------------------------ sign-in and the web app

  // Sign-in, sign-up and password resets, limited per IP address so they cannot be scripted.
  api.post('/auth/*', async (c, next) => {
    const path = c.req.path;
    const limit = path.includes('/sign-up') ? LIMITS.signUp : path.includes('/sign-in') ? LIMITS.signIn : /password/.test(path) ? LIMITS.reset : null;
    if (limit) await engine.hitLimit(`ip:${limit === LIMITS.signUp ? 'up' : limit === LIMITS.signIn ? 'in' : 'reset'}:${clientIp(c.req.raw.headers)}`, limit);
    await next();
  });
  api.on(['GET', 'POST'], '/auth/*', (c) => options.auth.handler(c.req.raw));
  api.route('/app', dashboardRoutes({ engine, db, auth: options.auth, webOrigin: options.webOrigin }));
  return api;
}

function publicTenant(t: typeof tenants.$inferSelect) {
  return { id: t.externalId, name: t.name, fromEmail: t.fromEmail, replyTo: t.replyTo, status: t.status, pausedReason: t.pausedReason, timezone: t.timezone, brand: t.brand };
}
export { createAuth } from './auth.ts';
