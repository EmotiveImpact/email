/**
 * Campaigns: write once, send to a segment. Sending expands the audience into one stored message
 * per person (so each has its own history and unsubscribe link) and paces them through the queue.
 */
import { EmailDoc, fillMergeTags, problems, renderEmail, starterDoc, themeFromBrand, unknownMergeTags, type SlotLink } from '@platform/content';
import {
  and,
  campaigns,
  contacts,
  desc,
  eq,
  inArray,
  messageEvents,
  messages,
  newId,
  segments,
  sql,
  suppressions,
  tenants,
  type CampaignStatus,
  type Db,
} from '@platform/db';
import { compileSegment, parseDefinition } from './audience.ts';
import type { createDiary } from './diary.ts';
import { sampleSlots } from './slots.ts';
import type { Queue } from './queue.ts';
import { PlatformError } from './types.ts';

export type CampaignDeps = {
  db: Db;
  queue: Queue;
  /** Who a business's email comes from (see domains.ts). */
  senderFor: (tenant: typeof tenants.$inferSelect) => Promise<{ from: string; replyTo: string | null; own: boolean }>;
  /** Emails per second this platform may send (the SES account's rate, shared by everyone). */
  sendRate: number;
  /** Visit history and free times, for personal merge tags and the free-times block. */
  diary: ReturnType<typeof createDiary>;
  /** Free times as booking links, for the free-times block (see flows.ts). */
  upcomingSlots: (tenant: typeof tenants.$inferSelect) => Promise<SlotLink[]>;
  /** What the business's plan stops from going out (see billing.ts). Null when nothing does. */
  sendingProblem: (tenantId: string, count: number) => Promise<string | null>;
};

/** Test sends a business can make in a day. */
export const TESTS_PER_DAY = 25;

/** Made-up values for tests and previews, so every merge tag shows something sensible. */
export function sampleValues(tenant: { name: string; brand: { bookingUrl?: string; reviewUrl?: string } }, email: string) {
  return {
    first_name: 'Ama',
    last_name: 'Mensah',
    email,
    business_name: tenant.name,
    booking_url: tenant.brand.bookingUrl ?? '#',
    review_url: tenant.brand.reviewUrl ?? '#',
    last_service: 'Balayage',
    weeks_since_visit: '7',
    slot_day: 'Thursday',
  };
}

/** True when the email links to the booking page through {{booking_url}}. */
export const usesBookingUrl = (subject: string, content: unknown) => /\{\{\s*booking_url/.test(`${subject} ${JSON.stringify(content)}`);

type Campaign = typeof campaigns.$inferSelect;

export function parseContent(raw: unknown) {
  const result = EmailDoc.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new PlatformError('invalid_request', `content.${issue.path.join('.')}: ${issue.message}`, 422);
  }
  return result.data;
}

export function createCampaigns({ db, queue, senderFor, sendRate, diary, upcomingSlots, sendingProblem }: CampaignDeps) {
  async function tenantById(tenantId: string) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw new PlatformError('not_found', 'No such business.', 404);
    return tenant;
  }

  /** Free times for the free-times block, if the email has one. Tests and previews fall back to examples. */
  async function slotsFor(tenant: typeof tenants.$inferSelect, doc: EmailDoc, sample: boolean) {
    if (!doc.blocks.some((b) => b.type === 'slots')) return [];
    const slots = await upcomingSlots(tenant);
    return slots.length || !sample ? slots : sampleSlots(tenant.timezone, tenant.brand.bookingUrl, new Date(), true);
  }

  async function getCampaign(tenantId: string, id: string) {
    const [row] = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, tenantId)));
    if (!row) throw new PlatformError('not_found', 'No campaign with that id.', 404);
    return row;
  }

  async function createCampaign(tenantId: string, input: { name?: string; subject?: string; segmentId?: string | null; content?: unknown }, createdBy?: string) {
    const tenant = await tenantById(tenantId);
    const starter = input.content === undefined;
    // The starter is a "space this week" email, so it arrives with a subject to match; owners can
    // send it as it is or change it.
    const name = input.name?.trim() || (starter ? 'Space this week' : 'Untitled campaign');
    const content = starter ? starterDoc(tenant.name, tenant.brand?.bookingUrl) : parseContent(input.content);
    const subject = input.subject ?? (starter ? 'A few spaces this week, {{first_name|there}}' : '');
    if (input.segmentId) await segmentOf(tenantId, input.segmentId);
    const [row] = await db
      .insert(campaigns)
      .values({ id: newId('cmp'), tenantId, name, subject, content, segmentId: input.segmentId ?? null, createdBy })
      .returning();
    return row!;
  }

  async function segmentOf(tenantId: string, segmentId: string) {
    const [segment] = await db
      .select()
      .from(segments)
      .where(and(eq(segments.id, segmentId), eq(segments.tenantId, tenantId)));
    if (!segment) throw new PlatformError('invalid_request', 'That segment does not belong to this business.', 422);
    return segment;
  }

  async function updateCampaign(tenantId: string, id: string, patch: { name?: string; subject?: string; segmentId?: string | null; content?: unknown }) {
    const current = await getCampaign(tenantId, id);
    if (current.status !== 'draft') throw new PlatformError('not_editable', 'Only drafts can be changed. Unschedule it first.', 409);
    if (patch.segmentId) await segmentOf(tenantId, patch.segmentId);
    const [row] = await db
      .update(campaigns)
      .set({
        ...(patch.name !== undefined && { name: patch.name.trim() || current.name }),
        ...(patch.subject !== undefined && { subject: patch.subject }),
        ...(patch.segmentId !== undefined && { segmentId: patch.segmentId }),
        ...(patch.content !== undefined && { content: parseContent(patch.content) }),
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, id))
      .returning();
    return row!;
  }

  async function deleteCampaign(tenantId: string, id: string) {
    const current = await getCampaign(tenantId, id);
    if (current.status === 'sending' || current.status === 'sent') throw new PlatformError('not_editable', 'Sent campaigns are kept for their results.', 409);
    await db.delete(campaigns).where(eq(campaigns.id, id));
  }

  /** Who a campaign would reach right now, and who it would leave out and why. */
  async function audienceFor(tenantId: string, segmentId: string | null) {
    const inSegment = segmentId ? compileSegment(parseDefinition((await segmentOf(tenantId, segmentId)).definition)) : sql`true`;
    const blocked = sql`exists (select 1 from ${suppressions} s where s.email = ${contacts.email} and s.scope in (${tenantId}, 'global'))`;
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        noConsent: sql<number>`(count(*) filter (where ${contacts.marketingConsent} <> 'granted'))::int`,
        suppressed: sql<number>`(count(*) filter (where ${contacts.marketingConsent} = 'granted' and ${blocked}))::int`,
      })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), inSegment));
    const { total, noConsent, suppressed } = row!;
    return { total, noConsent, suppressed, eligible: total - noConsent - suppressed };
  }

  /** Checks a campaign can go: subject, sender, content and an audience. Returns what to fix. */
  async function readiness(campaign: Campaign) {
    const tenant = await tenantById(campaign.tenantId);
    const doc = parseContent(campaign.content);
    const found = [...problems(doc)];
    if (!campaign.subject.trim()) found.unshift('Add a subject line.');
    const typos = unknownMergeTags(`${campaign.subject} ${JSON.stringify(doc.blocks)}`);
    if (typos.length) found.push(`Unknown merge tag: {{${typos[0]}}}.`);
    if (!tenant.brand.address?.trim()) found.push('Add your postal address in Appearance; it goes at the foot of the email.');
    if (!tenant.brand.bookingUrl && usesBookingUrl(campaign.subject, doc.blocks)) found.push('Add your booking link in Appearance; this email uses it.');
    if (tenant.status === 'paused') found.push('Sending is paused for this business.');
    const audience = await audienceFor(campaign.tenantId, campaign.segmentId);
    if (audience.eligible === 0) found.push('Nobody in this audience has said yes to news.');
    else {
      const limit = await sendingProblem(campaign.tenantId, audience.eligible);
      if (limit) found.push(limit);
    }
    return { problems: found, audience };
  }

  /** Queues the campaign to go now or at `at`. It is checked again when it goes. */
  async function scheduleCampaign(tenantId: string, id: string, at?: Date) {
    const campaign = await getCampaign(tenantId, id);
    if (campaign.status !== 'draft') throw new PlatformError('not_editable', 'This campaign has already been scheduled or sent.', 409);
    const { problems: found } = await readiness(campaign);
    if (found.length) throw new PlatformError('not_ready', found[0]!, 422);
    const when = at && at.getTime() > Date.now() ? at : new Date();
    const [row] = await db
      .update(campaigns)
      .set({ status: 'scheduled', scheduledAt: when, problem: null, updatedAt: new Date() })
      .where(and(eq(campaigns.id, id), eq(campaigns.status, 'draft')))
      .returning();
    if (!row) throw new PlatformError('not_editable', 'This campaign changed while you were scheduling it.', 409);
    await queue.enqueue('send-campaign', { campaignId: id }, { startAfter: when });
    return row;
  }

  /** Back to draft. A queued send job finds it no longer scheduled and does nothing. */
  async function unscheduleCampaign(tenantId: string, id: string) {
    await getCampaign(tenantId, id);
    const [row] = await db
      .update(campaigns)
      .set({ status: 'draft', scheduledAt: null, updatedAt: new Date() })
      .where(and(eq(campaigns.id, id), eq(campaigns.status, 'scheduled')))
      .returning();
    if (!row) throw new PlatformError('not_editable', 'It is already going out.', 409);
    return row;
  }

  /** The send job: one stored, personalised message per eligible person, paced through the queue. */
  async function processCampaign(campaignId: string) {
    const [campaign] = await db
      .update(campaigns)
      .set({ status: 'sending', updatedAt: new Date() })
      .where(and(eq(campaigns.id, campaignId), inArray(campaigns.status, ['scheduled', 'sending'])))
      .returning();
    if (!campaign) return; // unscheduled, or already done
    if (campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now() + 60_000) {
      // Moved later after the job was queued: put it back and wait.
      await db.update(campaigns).set({ status: 'scheduled' }).where(eq(campaigns.id, campaignId));
      await queue.enqueue('send-campaign', { campaignId }, { startAfter: campaign.scheduledAt });
      return;
    }
    const tenant = await tenantById(campaign.tenantId);
    const doc = parseContent(campaign.content);
    const slots = await slotsFor(tenant, doc, false);
    const { html, text } = await renderEmail(doc, themeFromBrand(tenant.name, tenant.brand), { slots });
    const rhythms = new Map((await diary.rhythms(campaign.tenantId)).map((r) => [r.contactId, r]));
    const audience = await audienceFor(campaign.tenantId, campaign.segmentId);
    const inSegment = campaign.segmentId
      ? compileSegment(parseDefinition((await segmentOf(campaign.tenantId, campaign.segmentId)).definition))
      : sql`true`;
    const people = await db
      .select({ id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, campaign.tenantId),
          eq(contacts.marketingConsent, 'granted'),
          inSegment,
          sql`not exists (select 1 from ${suppressions} s where s.email = ${contacts.email} and s.scope in (${campaign.tenantId}, 'global'))`,
        ),
      );

    // Checked again at send time: the plan or the list may have changed since it was scheduled.
    const limit = await sendingProblem(campaign.tenantId, people.length);
    if (limit) {
      await db.update(campaigns).set({ status: 'draft', scheduledAt: null, problem: `Not sent. ${limit}`, updatedAt: new Date() }).where(eq(campaigns.id, campaignId));
      return;
    }

    const { from, replyTo } = await senderFor(tenant);
    const start = Date.now();
    let index = 0;
    for (let i = 0; i < people.length; i += 500) {
      const rows = people.slice(i, i + 500).map((p) => {
        const rhythm = rhythms.get(p.id);
        const values = {
          first_name: p.firstName,
          last_name: p.lastName,
          email: p.email,
          business_name: tenant.name,
          booking_url: tenant.brand.bookingUrl ?? '',
          review_url: tenant.brand.reviewUrl ?? '',
          last_service: rhythm?.lastService ?? '',
          weeks_since_visit: rhythm?.lastVisit ? String(Math.max(1, Math.round((start - rhythm.lastVisit.getTime()) / (7 * 86_400_000)))) : '',
          slot_day: '',
        };
        return {
          id: newId('msg'),
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          stream: 'marketing' as const,
          to: p.email,
          from,
          replyTo,
          subject: fillMergeTags(campaign.subject, values, { html: false }),
          html: fillMergeTags(html, values),
          text: fillMergeTags(text, values, { html: false }),
          tags: { campaign: campaign.id },
        };
      });
      const inserted = await db.insert(messages).values(rows).onConflictDoNothing().returning({ id: messages.id });
      await queue.enqueueMany(
        'send-message',
        inserted.map((m) => ({ data: { messageId: m.id }, startAfter: new Date(start + (index++ / sendRate) * 1000) })),
      );
    }
    await db
      .update(campaigns)
      .set({
        status: 'sent',
        sentAt: new Date(),
        recipients: people.length,
        skippedNoConsent: audience.noConsent,
        skippedSuppressed: audience.suppressed,
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));
  }

  /** A copy to one address, marked as a test, with sample merge values. */
  async function sendTest(tenantId: string, id: string, to: string) {
    const campaign = await getCampaign(tenantId, id);
    const tenant = await tenantById(tenantId);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new PlatformError('invalid_request', 'That email address does not look right.', 422);
    const [blocked] = await db
      .select({ reason: suppressions.reason })
      .from(suppressions)
      .where(and(eq(suppressions.email, to.toLowerCase()), inArray(suppressions.scope, [tenantId, 'global'])));
    if (blocked) throw new PlatformError('suppressed', 'That address bounced or unsubscribed, so we will not send to it.', 422);
    const [{ n }] = (await db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${messages} where tenant_id = ${tenantId} and tags ->> 'test' = 'true' and created_at > now() - interval '1 day'`,
    )).rows as [{ n: number }];
    if (n >= TESTS_PER_DAY) throw new PlatformError('rate_limited', `That is ${TESTS_PER_DAY} test emails today. More tomorrow.`, 429);
    const doc = parseContent(campaign.content);
    const slots = await slotsFor(tenant, doc, true);
    const { html, text } = await renderEmail(doc, themeFromBrand(tenant.name, tenant.brand), { slots });
    const values = sampleValues(tenant, to);
    const sender = await senderFor(tenant);
    const [row] = await db
      .insert(messages)
      .values({
        id: newId('msg'),
        tenantId,
        stream: 'transactional',
        to: to.toLowerCase(),
        from: sender.from,
        replyTo: sender.replyTo,
        subject: `[Test] ${fillMergeTags(campaign.subject || campaign.name, values, { html: false })}`,
        html: fillMergeTags(html, values),
        text: fillMergeTags(text, values, { html: false }),
        tags: { campaign: campaign.id, test: 'true' },
      })
      .returning();
    await queue.enqueue('send-message', { messageId: row!.id });
    return row!;
  }

  /** Results: how many got it, opened, clicked, bounced, complained or unsubscribed. */
  async function campaignStats(campaignIds: string[], tenantId?: string) {
    if (campaignIds.length === 0) return new Map<string, ReturnType<typeof emptyStats>>();
    const [byStatus, byEvent, attribution] = await Promise.all([
      db
        .select({ campaignId: messages.campaignId, status: messages.status, n: sql<number>`count(*)::int` })
        .from(messages)
        .where(inArray(messages.campaignId, campaignIds))
        .groupBy(messages.campaignId, messages.status),
      db
        .select({ campaignId: messages.campaignId, type: messageEvents.type, n: sql<number>`count(distinct ${messageEvents.messageId})::int` })
        .from(messageEvents)
        .innerJoin(messages, eq(messages.id, messageEvents.messageId))
        .where(and(inArray(messages.campaignId, campaignIds), inArray(messageEvents.type, ['open', 'click', 'unsubscribe'])))
        .groupBy(messages.campaignId, messageEvents.type),
      tenantId ? diary.attribution(tenantId).then((a) => a.campaigns) : new Map<string, { bookings: number; revenue: number }>(),
    ]);
    const out = new Map(campaignIds.map((id) => [id, emptyStats()]));
    for (const r of byStatus) {
      const s = out.get(r.campaignId!)!;
      s.total += r.n;
      if (r.status === 'delivered' || r.status === 'complained') s.delivered += r.n;
      if (r.status === 'bounced') s.bounced += r.n;
      if (r.status === 'complained') s.complained += r.n;
      if (r.status === 'queued' || r.status === 'sending') s.pending += r.n;
    }
    for (const r of byEvent) {
      const s = out.get(r.campaignId!)!;
      if (r.type === 'open') s.opened = r.n;
      if (r.type === 'click') s.clicked = r.n;
      if (r.type === 'unsubscribe') s.unsubscribed = r.n;
    }
    // Bookings that followed the email (see diary.ts for how they are credited).
    for (const [id, v] of attribution) if (out.has(id)) Object.assign(out.get(id)!, v);
    return out;
  }

  async function listCampaigns(tenantId: string) {
    const rows = await db.select().from(campaigns).where(eq(campaigns.tenantId, tenantId)).orderBy(desc(campaigns.createdAt));
    const stats = await campaignStats(rows.filter((r) => r.status === 'sent' || r.status === 'sending').map((r) => r.id), tenantId);
    return rows.map((r) => ({ ...r, stats: stats.get(r.id) ?? null }));
  }

  async function campaignDetail(tenantId: string, id: string) {
    const campaign = await getCampaign(tenantId, id);
    const [{ problems: found, audience }, stats] = await Promise.all([
      campaign.status === 'draft' ? readiness(campaign) : Promise.resolve({ problems: [] as string[], audience: null }),
      campaignStats([campaign.id], tenantId),
    ]);
    const sender = await senderFor(await tenantById(tenantId));
    return {
      ...campaign,
      problems: found,
      audience,
      sender: { from: sender.from, own: sender.own },
      stats: campaign.status === 'sent' || campaign.status === 'sending' ? stats.get(campaign.id)! : null,
    };
  }

  /** The email as it will look, for the editor's preview. */
  async function previewCampaign(tenantId: string, content: unknown) {
    const tenant = await tenantById(tenantId);
    const doc = parseContent(content);
    const slots = await slotsFor(tenant, doc, true);
    const { html } = await renderEmail(doc, themeFromBrand(tenant.name, tenant.brand), { slots });
    return fillMergeTags(html, sampleValues(tenant, 'ama@example.com')).replaceAll('{{unsubscribe_url}}', '#');
  }

  return {
    createCampaign,
    getCampaign,
    updateCampaign,
    deleteCampaign,
    audienceFor,
    scheduleCampaign,
    unscheduleCampaign,
    processCampaign,
    sendTest,
    listCampaigns,
    campaignDetail,
    previewCampaign,
  };
}

function emptyStats() {
  return { total: 0, pending: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, unsubscribed: 0, bookings: 0, revenue: 0 };
}

export type CampaignStatusName = CampaignStatus;
