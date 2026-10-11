/**
 * The web app's endpoints, under /app. Everything here needs a signed-in person and works inside
 * their active account; businesses are addressed by their internal id.
 *
 * The embedded studio uses the same endpoints with a studio session token instead of a sign-in
 * cookie. That session reaches one business only, and none of the account-level settings.
 */
import { and, apps, ASSET_KINDS, eq, members, messages, PLAN_IDS, sql, tenants, users, type AssetKind, type Db, type PlanId } from '@platform/db';
import { LIMITS, MAX_ASSET_BYTES, parseDefinition, PlatformError, slugify, type Engine, type StudioViewer } from '@platform/engine';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
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
  return {
    id: t.id,
    externalId: t.externalId,
    app: appName ?? null,
    name: t.name,
    fromEmail: t.fromEmail,
    replyTo: t.replyTo,
    status: t.status,
    pausedReason: t.pausedReason,
    timezone: t.timezone,
    brand: t.brand,
  };
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

const tooLargeRequest = (): never => {
  throw new PlatformError('too_large', 'That request is too large.', 413);
};

const tooLarge = (): never => {
  throw new PlatformError('too_large', 'Pictures can be up to 5 MB. Try a smaller or more compressed file.', 413);
};

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

  // A page on another site cannot make changes with someone's cookie: browsers always say where a
  // request came from, and only the web app may write (D115).
  r.use(async (c, next) => {
    const origin = c.req.header('origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && origin && origin !== webOrigin) {
      throw new PlatformError('forbidden', 'Requests must come from the app.', 403);
    }
    // Pictures and designs have their own, larger limits.
    if (/\/(assets|designs)(\/|$)/.test(c.req.path)) return next();
    return bodyLimit({ maxSize: 1024 * 1024, onError: tooLargeRequest })(c, next);
  });

  r.use(async (c, next) => {
    const header = c.req.header('authorization');
    if (header?.startsWith('Studio ')) {
      const studio = await engine.studioViewer(header.slice(7).trim());
      if (!studio) throw new PlatformError('studio_expired', 'This studio session has ended. Open it again from your app.', 401);
      const account = c.req.path.match(/\/app\/(accounts|studio)/) || (c.req.path.endsWith('/tenants') && c.req.method !== 'GET') || c.req.path.endsWith('/brand') || c.req.path.endsWith('/resume') || c.req.path.includes('/billing');
      if (account) throw new PlatformError('forbidden', 'The studio cannot change account settings.', 403);
      c.set('studio', studio);
      c.set('viewer', studio.user);
      c.set('accountId', studio.accountId);
      await engine.hitLimit(`studio:${studio.tenantId}:${studio.user.id}`, LIMITS.dashboard);
      return next();
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new PlatformError('unauthorised', 'Sign in first.', 401);
    const memberships = await db.select({ accountId: members.organizationId }).from(members).where(eq(members.userId, session.user.id));
    const active = session.session.activeOrganizationId;
    const accountId = memberships.find((m) => m.accountId === active)?.accountId ?? memberships[0]?.accountId;
    c.set('viewer', { id: session.user.id, name: session.user.name, email: session.user.email });
    await engine.hitLimit(`viewer:${session.user.id}`, LIMITS.dashboard);
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

  // ---------------------------------------------------------------- apps and API keys

  /** Keys reach every business of an app, so only the account's owners and admins handle them. */
  const accountAdmin = async (c: { var: Env['Variables'] }, what = 'manage apps and keys') => {
    const [row] = await db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.organizationId, c.var.accountId), eq(members.userId, c.var.viewer.id)));
    if (!row || !['owner', 'admin'].includes(row.role)) throw new PlatformError('forbidden', `Only the account’s owners and admins can ${what}.`, 403);
  };
  /** Money and sending reputation: owners and admins only, and never from inside a host app (D116). */
  const ownerOnly = async (c: { var: Env['Variables'] }, what: string) => {
    if (c.var.studio) throw new PlatformError('forbidden', 'The studio cannot change account settings.', 403);
    await accountAdmin(c, what);
  };

  r.get('/accounts/current/apps', async (c) => c.json(await engine.listApps(c.var.accountId)));

  r.post('/accounts/current/apps', async (c) => {
    await accountAdmin(c);
    return c.json(await engine.addApp(c.var.accountId, await json(c)), 201);
  });

  r.put('/accounts/current/apps/:appId/origins', async (c) => {
    await accountAdmin(c);
    return c.json({ origins: await engine.setAppEmbedOrigins(c.var.accountId, c.req.param('appId'), await json(c)) });
  });

  r.post('/accounts/current/apps/:appId/keys', async (c) => {
    await accountAdmin(c);
    return c.json(await engine.addApiKey(c.var.accountId, c.req.param('appId'), await json(c)), 201);
  });

  r.delete('/accounts/current/keys/:keyId', async (c) => {
    await accountAdmin(c);
    await engine.revokeApiKey(c.var.accountId, c.req.param('keyId'));
    return c.body(null, 204);
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
    const [direct] = await db.select().from(apps).where(and(eq(apps.accountId, c.var.accountId), eq(apps.direct, true))).orderBy(apps.createdAt);
    const app = direct ?? (await engine.createApp(c.var.accountId, 'Direct', { direct: true }));
    const given = (key: string) => (typeof body[key] === 'string' && body[key].trim() ? body[key].trim() : undefined);
    const tenant = await engine.upsertTenant(app.id, slugify(name, crypto.randomUUID()), {
      name,
      fromEmail: given('fromEmail'),
      timezone: given('timezone'),
      brand: { address: given('address'), bookingUrl: given('bookingUrl'), accent: given('accent') },
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
    const { timezone, ...brand } = await json(c);
    const updated = await engine.upsertTenant(tenant.appId, tenant.externalId, {
      name: tenant.name,
      fromEmail: tenant.fromEmail ?? undefined,
      replyTo: tenant.replyTo ?? undefined,
      sesTenant: tenant.sesTenant ?? undefined,
      ...(typeof timezone === 'string' && timezone && { timezone }),
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
    // Each person's rhythm from the diary, so the list can say who is due.
    const rhythms = new Map((await engine.rhythms(tenant.id)).map((r) => [r.contactId, r]));
    return c.json({ ...result, contacts: result.contacts.map((contact) => ({ ...contact, rhythm: rhythms.get(contact.id) ?? null })) });
  });

  r.post('/tenants/:id/contacts', async (c) => {
    const tenant = await tenantOf(c);
    const body = await json(c);
    const consent = body.consent === true ? ({ marketing: 'granted', source: c.var.studio ? `added-in:${c.var.studio.appId}:${c.var.viewer.email ?? c.var.viewer.id}` : `added-by:${c.var.viewer.email}` } as const) : undefined;
    return c.json(await engine.addContact(tenant.id, body, consent), 201);
  });

  r.get('/tenants/:id/contacts/:contactId', async (c) => {
    const tenant = await tenantOf(c);
    const detail = await engine.contactDetail(tenant.id, c.req.param('contactId'));
    const [rhythm, appointments] = await Promise.all([engine.rhythmFor(tenant.id, detail.contact.id), engine.appointmentsFor(tenant.id, detail.contact.id)]);
    return c.json({ ...detail, rhythm, appointments });
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

  // ---------------------------------------------------------------- sending domain and reputation

  r.get('/tenants/:id/sending', async (c) => {
    const tenant = await tenantOf(c);
    const [domains, reputation, sender] = await Promise.all([engine.listDomains(tenant.id), engine.reputation(tenant.id), engine.senderFor(tenant)]);
    return c.json({ domains, reputation, sender: { from: sender.from, replyTo: sender.replyTo, own: sender.own } });
  });

  r.post('/tenants/:id/domains', async (c) => {
    const tenant = await tenantOf(c);
    const body = await json(c);
    const domain = await engine.addDomain(tenant.id, body.domain);
    // Send from hello@ the new domain unless the business already chose an address there.
    const local = typeof body.localPart === 'string' && /^[a-z0-9._+-]{1,64}$/i.test(body.localPart) ? body.localPart.toLowerCase() : 'hello';
    if (!tenant.fromEmail?.endsWith(`@${domain.domain}`)) {
      await engine.upsertTenant(tenant.appId, tenant.externalId, {
        name: tenant.name,
        fromEmail: `${local}@${domain.domain}`,
        replyTo: tenant.replyTo ?? tenant.fromEmail ?? undefined,
        brand: tenant.brand,
      });
    }
    return c.json(domain, 201);
  });

  r.post('/tenants/:id/domains/:domainId/check', async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.checkTenantDomain(tenant.id, c.req.param('domainId')));
  });

  r.delete('/tenants/:id/domains/:domainId', async (c) => {
    const tenant = await tenantOf(c);
    await ownerOnly(c, 'remove a sending domain');
    await engine.removeDomain(tenant.id, c.req.param('domainId'));
    return c.body(null, 204);
  });

  /** Sending again after the reputation guard paused a business. Owners and admins only. */
  r.post('/tenants/:id/resume', async (c) => {
    const tenant = await tenantOf(c);
    await ownerOnly(c, 'resume sending');
    return c.json(dashboardTenant(await engine.resumeTenant(tenant.id)));
  });

  // ---------------------------------------------------------------- campaigns

  const campaignInput = (body: Record<string, unknown>) => ({
    ...(typeof body.name === 'string' && { name: body.name }),
    ...(typeof body.subject === 'string' && { subject: body.subject }),
    ...(body.segmentId !== undefined && { segmentId: typeof body.segmentId === 'string' && body.segmentId ? body.segmentId : null }),
    ...(body.content !== undefined && { content: body.content }),
    ...(typeof body.play === 'string' && { play: body.play }),
  });

  r.get('/tenants/:id/campaigns', async (c) => c.json(await engine.listCampaigns((await tenantOf(c)).id)));
  /** Ready-made campaigns to start from. */
  r.get('/plays', (c) => c.json(engine.listPlays()));

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
    return c.json(await engine.previewCampaign(tenant.id, (await json(c)).content));
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
    const to = String((await json(c)).to ?? c.var.viewer.email ?? '').trim().toLowerCase();
    // Tests go only to the person sending them or someone on their team, so the button cannot be
    // used to email strangers (D111).
    if (to !== c.var.viewer.email?.toLowerCase()) {
      const team = c.var.studio
        ? []
        : await db
            .select({ email: users.email })
            .from(members)
            .innerJoin(users, eq(users.id, members.userId))
            .where(and(eq(members.organizationId, c.var.accountId), sql`lower(${users.email}) = ${to}`));
      if (!team.length) throw new PlatformError('forbidden', 'Test emails go to you or someone on your team. Invite them first to send them one.', 403);
    }
    const message = await engine.sendTest(tenant.id, c.req.param('campaignId'), to);
    return c.json({ to: message.to }, 202);
  });

  // ---------------------------------------------------------------- diary and flows

  /** The week ahead: free and booked time per day, and who is due back with nothing booked. */
  r.get('/tenants/:id/diary', async (c) => {
    const tenant = await tenantOf(c);
    const [week, due] = await Promise.all([engine.diaryDays(tenant.id, 7), engine.dueSoon(tenant.id, 7)]);
    return c.json({ ...week, dueCount: due.length, due: due.slice(0, 8) });
  });

  /** Home: money booked from email, the week by time of day, and what is worth doing today. */
  r.get('/tenants/:id/overview', async (c) => {
    const tenant = await tenantOf(c);
    const days = Number(c.req.query('days') ?? 30);
    if (![7, 30, 90].includes(days)) throw new PlatformError('invalid_request', 'days must be 7, 30 or 90.', 422);
    return c.json(await engine.overview(tenant.id, days));
  });

  r.get('/tenants/:id/flows', async (c) => c.json(await engine.listFlows((await tenantOf(c)).id)));

  r.get('/tenants/:id/flows/:flowId', async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.flowDetail(tenant.id, c.req.param('flowId')));
  });

  r.put('/tenants/:id/flows/:flowId', async (c) => {
    const tenant = await tenantOf(c);
    const body = await json(c);
    await engine.updateFlow(tenant.id, c.req.param('flowId'), {
      ...(typeof body.subject === 'string' && { subject: body.subject }),
      ...(body.content !== undefined && { content: body.content }),
      ...(typeof body.settings === 'object' && body.settings !== null ? { settings: body.settings as Record<string, unknown> } : {}),
      ...(typeof body.live === 'boolean' && { live: body.live }),
    });
    return c.json(await engine.flowDetail(tenant.id, c.req.param('flowId')));
  });

  r.post('/tenants/:id/flows/:flowId/reset', async (c) => {
    const tenant = await tenantOf(c);
    await engine.resetFlow(tenant.id, c.req.param('flowId'));
    return c.json(await engine.flowDetail(tenant.id, c.req.param('flowId')));
  });

  r.post('/tenants/:id/flows/:flowId/preview', async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.previewFlow(tenant.id, c.req.param('flowId'), (await json(c)).content));
  });

  // ---------------------------------------------------------------- pictures

  /** The library, with what the image provider allows today. */
  r.get('/tenants/:id/assets', async (c) => {
    const tenant = await tenantOf(c);
    const kind = c.req.query('kind');
    if (kind && !ASSET_KINDS.includes(kind as AssetKind)) throw new PlatformError('invalid_request', `kind must be one of ${ASSET_KINDS.join(', ')}.`, 422);
    const [items, images] = await Promise.all([engine.listAssets(tenant.id, kind as AssetKind | undefined), engine.imageSettings(tenant.id)]);
    return c.json({ assets: items, images });
  });

  /** An upload: the file itself is the body, its name in ?name=. */
  r.post('/tenants/:id/assets', bodyLimit({ maxSize: MAX_ASSET_BYTES + 1024, onError: tooLarge }), async (c) => {
    const tenant = await tenantOf(c);
    const data = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await engine.uploadAsset(tenant.id, { data, name: c.req.query('name'), createdBy: c.var.viewer.id }), 201);
  });

  r.post('/tenants/:id/assets/generate', async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.generateImages(tenant.id, await json(c), c.var.viewer.id), 201);
  });

  r.patch('/tenants/:id/assets/:assetId', async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.renameAsset(tenant.id, c.req.param('assetId'), (await json(c)).name));
  });

  r.delete('/tenants/:id/assets/:assetId', async (c) => {
    const tenant = await tenantOf(c);
    await engine.deleteAsset(tenant.id, c.req.param('assetId'));
    return c.body(null, 204);
  });

  /** Designs carry their layers and the PNG drawn from them (base64), so they can be opened again. */
  const designLimit = bodyLimit({ maxSize: Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 256 * 1024, onError: tooLarge });

  r.post('/tenants/:id/designs', designLimit, async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.createDesign(tenant.id, await json(c), c.var.viewer.id), 201);
  });

  r.put('/tenants/:id/designs/:assetId', designLimit, async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.updateDesign(tenant.id, c.req.param('assetId'), await json(c)));
  });

  // ---------------------------------------------------------------- getting started

  r.get('/tenants/:id/getting-started', async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.gettingStarted(tenant.id));
  });

  r.post('/tenants/:id/import/clients', async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.importClients(tenant.id, await json(c)));
  });

  r.post('/tenants/:id/import/visits', async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.importVisits(tenant.id, await json(c)));
  });

  // ---------------------------------------------------------------- billing

  r.get('/tenants/:id/billing', async (c) => {
    const tenant = await tenantOf(c);
    return c.json(await engine.billingSummary(tenant.id));
  });

  /** Pick a plan. Returns where to pay (Stripe Checkout or its portal), or no url when it is done. */
  r.post('/tenants/:id/billing/plan', async (c) => {
    const tenant = await tenantOf(c);
    await ownerOnly(c, 'change the plan');
    const plan = String((await json(c)).plan ?? '');
    if (!PLAN_IDS.includes(plan as PlanId)) throw new PlatformError('invalid_request', 'Choose one of the plans.', 422);
    const returnUrl = `${webOrigin}/${tenant.id}/billing`;
    return c.json(await engine.choosePlan(tenant.id, plan as PlanId, { email: c.var.viewer.email ?? undefined, returnUrl }));
  });

  r.post('/tenants/:id/billing/portal', async (c) => {
    const tenant = await tenantOf(c);
    await ownerOnly(c, 'manage payment');
    return c.json({ url: await engine.billingPortal(tenant.id, `${webOrigin}/${tenant.id}/billing`) });
  });

  return r;
}
