/**
 * The web app's endpoints, under /app. Everything here needs a signed-in person and works inside
 * their active account; businesses are addressed by their internal id.
 *
 * The embedded studio uses the same endpoints with a studio session token instead of a sign-in
 * cookie. That session reaches one business only, and none of the account-level settings.
 */
import { apps, eq, members, messages, tenants, type Db } from '@platform/db';
import { parseDefinition, PlatformError, slugify, type Engine, type StudioViewer } from '@platform/engine';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Auth } from './auth.ts';

/** Whoever is using the app: a signed-in person, or someone in a host app's embedded studio. */
type Viewer = { id: string; name: string; email: string | null };
type Env = { Variables: { viewer: Viewer; accountId: string; studio?: StudioViewer } };

/** How the Sending page groups statuses. */
export const SHOW = {
  arrived: ['queued', 'sending', 'sent', 'delivered', 'delivery_delayed'],
  held: ['suppressed'],
  problems: ['bounced', 'complained', 'rejected', 'failed'],
} as const satisfies Record<string, readonly (typeof messages.$inferSelect)['status'][]>;

export function dashboardTenant(t: typeof tenants.$inferSelect, appName?: string) {
  return { id: t.id, externalId: t.externalId, app: appName ?? null, name: t.name, fromEmail: t.fromEmail, replyTo: t.replyTo, status: t.status, brand: t.brand };
}

export function publicMessage(m: typeof messages.$inferSelect) {
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

const json = async (c: { req: { json: () => Promise<unknown> } }) => {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    throw new PlatformError('invalid_json', 'The request body must be JSON.', 400);
  }
};

export function dashboardRoutes({ engine, db, auth, webOrigin }: { engine: Engine; db: Db; auth: Auth; webOrigin: string }) {
  const r = new Hono<Env>();
  r.use(cors({ origin: webOrigin, credentials: true }));

  /** The studio swaps its one-time launch token for a session token. Needs no other sign-in. */
  r.post('/studio/exchange', async (c) => c.json(await engine.exchangeStudioToken((await json(c)).token)));

  r.use(async (c, next) => {
    const header = c.req.header('authorization');
    if (header?.startsWith('Studio ')) {
      const studio = await engine.studioViewer(header.slice(7).trim());
      if (!studio) throw new PlatformError('studio_expired', 'This studio session has ended. Open it again from your app.', 401);
      const account = c.req.path.match(/\/app\/(accounts|studio)/) || (c.req.path.endsWith('/tenants') && c.req.method !== 'GET') || c.req.path.endsWith('/brand');
      if (account) throw new PlatformError('forbidden', 'The studio cannot change account settings.', 403);
      c.set('studio', studio);
      c.set('viewer', studio.user);
      c.set('accountId', studio.accountId);
      return next();
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new PlatformError('unauthorised', 'Sign in first.', 401);
    const memberships = await db.select({ accountId: members.organizationId }).from(members).where(eq(members.userId, session.user.id));
    const active = session.session.activeOrganizationId;
    const accountId = memberships.find((m) => m.accountId === active)?.accountId ?? memberships[0]?.accountId;
    c.set('viewer', { id: session.user.id, name: session.user.name, email: session.user.email });
    if (accountId) c.set('accountId', accountId);
    else if (!(c.req.path.endsWith('/me') || (c.req.path.endsWith('/accounts') && c.req.method === 'POST'))) {
      throw new PlatformError('no_account', 'Create an account first.', 403);
    }
    await next();
  });

  const tenantOf = (c: { var: Env['Variables']; req: { param: (k: 'id') => string } }) => {
    if (c.var.studio && c.req.param('id') !== c.var.studio.tenantId) throw new PlatformError('not_found', 'No such business.', 404);
    return engine.tenantInAccount(c.var.accountId, c.req.param('id'));
  };

  // ---------------------------------------------------------------- who is signed in

  r.get('/me', async (c) => {
    const user = c.var.viewer;
    const { studio } = c.var;
    if (studio) {
      return c.json({
        user,
        accountId: studio.accountId,
        accounts: [],
        studio: { tenantId: studio.tenantId, origin: studio.origin, theme: studio.theme, expiresAt: studio.expiresAt },
      });
    }
    const list = await auth.api.listOrganizations({ headers: c.req.raw.headers });
    return c.json({
      user,
      studio: null,
      accountId: c.var.accountId ?? null,
      accounts: list.map((a) => ({ id: a.id, name: a.name })),
    });
  });

  /** A new account for the signed-in person, made active. It comes with a "Direct" app. */
  r.post('/accounts', async (c) => {
    const name = String((await json(c)).name ?? '').trim();
    if (!name) throw new PlatformError('invalid_request', 'Give the account a name.', 422);
    const created = await auth.api.createOrganization({ headers: c.req.raw.headers, body: { name, slug: slugify(name, crypto.randomUUID()) } });
    if (!created) throw new PlatformError('internal_error', 'Could not create the account.', 500);
    return c.json({ id: created.id, name: created.name }, 201);
  });

  r.post('/accounts/:accountId/switch', async (c) => {
    await auth.api.setActiveOrganization({ headers: c.req.raw.headers, body: { organizationId: c.req.param('accountId') } });
    return c.json({ accountId: c.req.param('accountId') });
  });

  // ---------------------------------------------------------------- businesses

  r.get('/tenants', async (c) => {
    const rows = (await engine.tenantsForAccount(c.var.accountId)).filter((row) => !c.var.studio || row.tenant.id === c.var.studio.tenantId);
    return c.json(rows.map((row) => dashboardTenant(row.tenant, row.appName)));
  });

  /** A business added from the app itself (not by an app through the API). */
  r.post('/tenants', async (c) => {
    const body = await json(c);
    const name = String(body.name ?? '').trim();
    if (!name) throw new PlatformError('invalid_request', 'Give the business a name.', 422);
    const [direct] = await db.select().from(apps).where(eq(apps.accountId, c.var.accountId)).orderBy(apps.createdAt);
    const app = direct ?? (await engine.createApp(c.var.accountId, 'Direct'));
    const tenant = await engine.upsertTenant(app.id, slugify(name, crypto.randomUUID()), {
      name,
      fromEmail: typeof body.fromEmail === 'string' && body.fromEmail ? body.fromEmail : undefined,
    });
    await engine.ensureStarterSegments(tenant.id);
    return c.json(dashboardTenant(tenant, app.name), 201);
  });

  r.get('/tenants/:id/activity', async (c) => {
    const tenant = await tenantOf(c);
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [recent, stats, daily] = await Promise.all([
      engine.listMessages(tenant.id, { limit: 10 }),
      engine.messageStats(tenant.id, since),
      engine.dailyCounts(tenant.id, since),
    ]);
    return c.json({ stats, daily, messages: recent.map(publicMessage) });
  });

  r.get('/tenants/:id/messages', async (c) => {
    const tenant = await tenantOf(c);
    const show = c.req.query('show') ?? 'all';
    if (show !== 'all' && !(show in SHOW)) throw new PlatformError('invalid_request', `show must be one of all, ${Object.keys(SHOW).join(', ')}.`, 422);
    const rows = await engine.listMessages(tenant.id, { limit: 100, statuses: SHOW[show as keyof typeof SHOW] });
    return c.json(rows.map(publicMessage));
  });

  r.put('/tenants/:id/brand', async (c) => {
    const tenant = await tenantOf(c);
    const brand = await json(c);
    const updated = await engine.upsertTenant(tenant.appId, tenant.externalId, {
      name: tenant.name,
      fromEmail: tenant.fromEmail ?? undefined,
      replyTo: tenant.replyTo ?? undefined,
      sesTenant: tenant.sesTenant ?? undefined,
      // An empty value clears that setting (a removed logo, say).
      brand: Object.fromEntries(Object.entries({ ...tenant.brand, ...brand }).filter(([, v]) => v !== '')) as never,
    });
    return c.json(dashboardTenant(updated));
  });

  // ---------------------------------------------------------------- audience

  r.get('/tenants/:id/contacts', async (c) => {
    const tenant = await tenantOf(c);
    const consent = c.req.query('consent');
    const segmentId = c.req.query('segment');
    const segment = segmentId ? parseDefinition((await engine.getSegment(tenant.id, segmentId)).definition) : undefined;
    const result = await engine.listContacts(tenant.id, {
      search: c.req.query('search'),
      consent: consent === 'granted' || consent === 'withdrawn' || consent === 'unknown' ? consent : undefined,
      segment,
      limit: Number(c.req.query('limit') ?? 50),
      offset: Number(c.req.query('offset') ?? 0),
    });
    return c.json(result);
  });

  r.post('/tenants/:id/contacts', async (c) => {
    const tenant = await tenantOf(c);
    const body = await json(c);
    const consent = body.consent === true ? ({ marketing: 'granted', source: c.var.studio ? `added-in:${c.var.studio.appId}:${c.var.viewer.email ?? c.var.viewer.id}` : `added-by:${c.var.viewer.email}` } as const) : undefined;
    return c.json(await engine.addContact(tenant.id, body, consent), 201);
  });

  r.get('/tenants/:id/contacts/:contactId', async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.contactDetail(tenant.id, c.req.param('contactId')));
  });

  r.get('/tenants/:id/segments', async (c) => c.json(await engine.listSegments((await tenantOf(c)).id)));

  r.get('/tenants/:id/vocabulary', async (c) => c.json(await engine.vocabulary((await tenantOf(c)).id)));

  /** Live count and a few names while someone builds a segment. */
  r.post('/tenants/:id/segments/preview', async (c) => {
    const tenant = await tenantOf(c);
    const definition = parseDefinition((await json(c)).definition);
    const { total, contacts } = await engine.listContacts(tenant.id, { segment: definition, limit: 5 });
    return c.json({ size: total, sample: contacts.map((p) => ({ id: p.id, email: p.email, firstName: p.firstName, lastName: p.lastName })) });
  });

  r.post('/tenants/:id/segments', async (c) => {
    const tenant = await tenantOf(c);
    const body = await json(c);
    return c.json(await engine.saveSegment(tenant.id, { name: String(body.name ?? ''), definition: body.definition }), 201);
  });

  r.put('/tenants/:id/segments/:segmentId', async (c) => {
    const tenant = await tenantOf(c);
    const body = await json(c);
    return c.json(await engine.saveSegment(tenant.id, { id: c.req.param('segmentId'), name: String(body.name ?? ''), definition: body.definition }));
  });

  r.delete('/tenants/:id/segments/:segmentId', async (c) => {
    const tenant = await tenantOf(c);
    await engine.deleteSegment(tenant.id, c.req.param('segmentId'));
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- campaigns

  const campaignInput = (body: Record<string, unknown>) => ({
    ...(typeof body.name === 'string' && { name: body.name }),
    ...(typeof body.subject === 'string' && { subject: body.subject }),
    ...(body.segmentId !== undefined && { segmentId: typeof body.segmentId === 'string' && body.segmentId ? body.segmentId : null }),
    ...(body.content !== undefined && { content: body.content }),
  });

  r.get('/tenants/:id/campaigns', async (c) => c.json(await engine.listCampaigns((await tenantOf(c)).id)));

  r.post('/tenants/:id/campaigns', async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.createCampaign(tenant.id, campaignInput(await json(c)), c.var.viewer.id), 201);
  });

  r.get('/tenants/:id/campaigns/:campaignId', async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.campaignDetail(tenant.id, c.req.param('campaignId')));
  });

  r.put('/tenants/:id/campaigns/:campaignId', async (c) => {
    const tenant = await tenantOf(c);
    await engine.updateCampaign(tenant.id, c.req.param('campaignId'), campaignInput(await json(c)));
    return c.json(await engine.campaignDetail(tenant.id, c.req.param('campaignId')));
  });

  r.delete('/tenants/:id/campaigns/:campaignId', async (c) => {
    const tenant = await tenantOf(c);
    await engine.deleteCampaign(tenant.id, c.req.param('campaignId'));
    return c.body(null, 204);
  });

  /** The email as HTML, for the editor's live preview. Takes unsaved content. */
  r.post('/tenants/:id/campaigns/preview', async (c) => {
    const tenant = await tenantOf(c);
    return c.json({ html: await engine.previewCampaign(tenant.id, (await json(c)).content) });
  });

  r.get('/tenants/:id/audience', async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.audienceFor(tenant.id, c.req.query('segment') || null));
  });

  r.post('/tenants/:id/campaigns/:campaignId/schedule', async (c) => {
    const tenant = await tenantOf(c);
    const body = await json(c);
    const at = typeof body.at === 'string' ? new Date(body.at) : undefined;
    if (at && Number.isNaN(at.getTime())) throw new PlatformError('invalid_request', 'That send time is not a date.', 422);
    await engine.scheduleCampaign(tenant.id, c.req.param('campaignId'), at);
    return c.json(await engine.campaignDetail(tenant.id, c.req.param('campaignId')));
  });

  r.post('/tenants/:id/campaigns/:campaignId/unschedule', async (c) => {
    const tenant = await tenantOf(c);
    await engine.unscheduleCampaign(tenant.id, c.req.param('campaignId'));
    return c.json(await engine.campaignDetail(tenant.id, c.req.param('campaignId')));
  });

  r.post('/tenants/:id/campaigns/:campaignId/test', async (c) => {
    const tenant = await tenantOf(c);
    const to = String((await json(c)).to ?? c.var.viewer.email ?? '');
    const message = await engine.sendTest(tenant.id, c.req.param('campaignId'), to);
    return c.json({ to: message.to }, 202);
  });

  return r;
}
