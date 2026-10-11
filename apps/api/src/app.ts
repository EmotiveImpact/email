import { and, eq, messages, tenants, type Db } from '@platform/db';
import {
  isSnsUrl,
  PlatformError,
  verifySnsMessage,
  WEBHOOK_EVENTS,
  type Engine,
  type SnsMessage,
  type WebhookEvent,
} from '@platform/engine';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

type App = Awaited<ReturnType<Engine['authenticate']>>;
type Env = { Variables: { app: App } };

export type ApiOptions = {
  engine: Engine;
  db: Db;
  /** Origin of the web app, allowed to call /app/*. */
  webOrigin: string;
  /** Only accept SES events from this SNS topic. */
  sesTopicArn?: string;
  /**
   * Serves the web app's /app/* endpoints for one demo app without sign-in. Local development only,
   * until accounts and sign-in arrive (stage 2).
   */
  devDashboardAppId?: string;
  verifySns?: (m: SnsMessage) => Promise<boolean>;
  fetch?: typeof fetch;
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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

  api.get('/health', (c) => c.json({ ok: true }));

  // ------------------------------------------------------------------ public API, /v1

  const v1 = new Hono<Env>();
  v1.use(async (c, next) => {
    const header = c.req.header('authorization');
    const key = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    c.set('app', await engine.authenticate(key));
    await next();
  });

  v1.put('/tenants/:externalId', async (c) => {
    const tenant = await engine.upsertTenant(c.var.app.id, c.req.param('externalId'), (await body(c)) as never);
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

  api.get('/u/:token', (c) => {
    // A page with a button, so link scanners that follow GETs cannot unsubscribe anyone.
    const action = escapeHtml(c.req.path);
    return c.html(
      page(
        'Unsubscribe',
        `<h1>Stop these emails?</h1><p>You will stop getting news and offers from this business. Booking reminders and receipts still arrive.</p>
<form method="post" action="${action}"><button type="submit">Unsubscribe</button></form>`,
      ),
    );
  });

  api.post('/u/:token', async (c) => {
    const { tenantName, email } = await engine.unsubscribe(c.req.param('token'));
    return c.html(page('Unsubscribed', `<h1>You are unsubscribed</h1><p>${escapeHtml(email)} will not get news from ${escapeHtml(tenantName)} again.</p>`));
  });

  // ------------------------------------------------------------------ the web app's own endpoints

  const appRoutes = new Hono<Env>();
  appRoutes.use(cors({ origin: options.webOrigin }));
  appRoutes.use(async (c, next) => {
    if (!options.devDashboardAppId) throw new PlatformError('not_found', 'Not found.', 404);
    await next();
  });

  appRoutes.get('/tenants', async (c) => {
    const rows = await db.select().from(tenants).where(eq(tenants.appId, options.devDashboardAppId!));
    return c.json(rows.map(publicTenant));
  });

  appRoutes.get('/tenants/:externalId/activity', async (c) => {
    const tenant = await engine.getTenant(options.devDashboardAppId!, c.req.param('externalId'));
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [recent, stats] = await Promise.all([engine.listMessages(tenant.id, 25), engine.messageStats(tenant.id, since)]);
    return c.json({ stats, messages: recent.map(publicMessage) });
  });

  appRoutes.put('/tenants/:externalId/brand', async (c) => {
    const tenant = await engine.getTenant(options.devDashboardAppId!, c.req.param('externalId'));
    const brand = (await body(c)) as Record<string, unknown>;
    const updated = await engine.upsertTenant(options.devDashboardAppId!, tenant.externalId, {
      name: tenant.name,
      fromEmail: tenant.fromEmail ?? undefined,
      replyTo: tenant.replyTo ?? undefined,
      sesTenant: tenant.sesTenant ?? undefined,
      brand: { ...tenant.brand, ...brand } as never,
    });
    return c.json(publicTenant(updated));
  });

  api.route('/app', appRoutes);
  return api;
}

function publicTenant(t: typeof tenants.$inferSelect) {
  return { id: t.externalId, name: t.name, fromEmail: t.fromEmail, replyTo: t.replyTo, status: t.status, brand: t.brand };
}

function publicMessage(m: typeof messages.$inferSelect) {
  return {
    id: m.id,
    stream: m.stream,
    to: m.to,
    from: m.from,
    subject: m.subject,
    status: m.status,
    reason: m.status === 'suppressed' || m.status === 'failed' ? m.error : null,
    tags: m.tags,
    createdAt: m.createdAt,
    sentAt: m.sentAt,
  };
}
