/**
 * Booking systems the platform reads directly (D132). The owner grants read access once; from then
 * on a timer (and Square's webhooks, when set up) brings in bookings and free times, exactly as a
 * host app would through the API. Square Appointments is the first.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, diaryConnections, eq, gte, newId, openSlots, sql, tenants, type Db } from '@platform/db';
import type { createDiary } from './diary.ts';
import type { Queue } from './queue.ts';
import { seal, unseal } from './seal.ts';
import { IMPORT_BATCH, type createOnboarding } from './onboarding.ts';
import { SquareClient, statusOf, type SquareBooking, type SquareCustomer } from './square.ts';
import { PlatformError } from './types.ts';

type Diary = ReturnType<typeof createDiary>;
type Consent = 'granted' | 'unknown';
/** Where consent confirmed by the owner for their Square clients is recorded as coming from. */
export const SQUARE_CONSENT_SOURCE = 'square:owner-confirmed';
type Connection = typeof diaryConnections.$inferSelect;

const DAY = 86_400_000;
/** How far back the first sync reads, so each client's rhythm is known from day one. */
export const FIRST_SYNC_DAYS = 180;
/** How far back later syncs re-read, to catch late changes such as a no-show marked next day. */
const RESYNC_DAYS = 7;
const AHEAD_DAYS = 30;
/** Free times are read this far ahead; flows and campaigns offer times inside it. */
const SLOT_DAYS = 14;

export function createConnections({
  db,
  queue,
  diary,
  importClients,
  setConsent,
  square,
  secret,
  webhookUrl,
}: {
  db: Db;
  queue: Queue;
  diary: Diary;
  importClients: ReturnType<typeof createOnboarding>['importClients'];
  setConsent: (tenantId: string, contactId: string, status: 'granted' | 'withdrawn', source: string) => Promise<boolean>;
  square: SquareClient | null;
  secret: string;
  /** The address Square posts booking changes to; its signature covers this exact URL. */
  webhookUrl: string;
}) {
  // ---------------------------------------------------------------- connecting

  /**
   * A signed, short-lived note of which business and which person asked to connect, carried through
   * Square and back. Finishing needs the same person signed in, so nobody can hand a business owner
   * a link that would connect their Square diary to someone else's account.
   */
  function stateFor(tenantId: string, userId: string, consent: Consent, now = Date.now()) {
    const body = Buffer.from(JSON.stringify({ t: tenantId, u: userId, c: consent, e: now + 15 * 60_000 })).toString('base64url');
    return `${body}.${macOf(body)}`;
  }

  function macOf(body: string) {
    return createHmac('sha256', secret).update(`connect:${body}`).digest('base64url').slice(0, 32);
  }

  /** The business and person a state was made for, or null when it is forged or expired. */
  function readState(state: string, now = Date.now()) {
    const [body, mac] = state.split('.');
    if (!body || !mac) return null;
    const expected = Buffer.from(macOf(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const { t, u, c, e } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { t: string; u: string; c: Consent; e: number };
      return e >= now ? { tenantId: t, userId: u, consent: c === 'granted' ? ('granted' as const) : ('unknown' as const) } : null;
    } catch {
      return null;
    }
  }

  function client() {
    if (!square) throw new PlatformError('not_configured', 'Connecting Square is not switched on for this platform yet.', 422);
    return square;
  }

  /**
   * Where to send the owner to grant read access to their Square diary. `consent` is what they
   * confirmed about their clients, asked before they leave, the same question as an import.
   */
  function squareConnectUrl(tenantId: string, userId: string, consent: Consent) {
    return { url: client().authorizeUrl(stateFor(tenantId, userId, consent)) };
  }

  /** Which business a returning state belongs to, so the callback can send the owner back to it. */
  function connectReturnTenant(state: string) {
    return readState(state)?.tenantId ?? null;
  }

  /** Square sent the owner back with a code. Saves the connection and starts the first sync. */
  async function finishSquareConnect(tenantId: string, userId: string, code: string, state: string) {
    const from = readState(state);
    if (!from || from.tenantId !== tenantId || from.userId !== userId) {
      throw new PlatformError('invalid_state', 'That link has expired. Start connecting again from this page.', 400);
    }
    const sq = client();
    const tokens = await sq.exchangeCode(code);
    const locations = (await sq.locations(tokens.accessToken)).filter((l) => l.status === 'ACTIVE');
    const location = locations[0];
    const values = {
      accountId: tokens.merchantId,
      locationId: location?.id ?? null,
      locationName: location?.name ?? null,
      accessToken: seal(secret, tokens.accessToken),
      refreshToken: tokens.refreshToken ? seal(secret, tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt,
      consent: from.consent,
      status: location ? ('active' as const) : ('error' as const),
      error: location ? null : 'Square has no active location for this business.',
      lastSyncAt: null,
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(diaryConnections)
      .values({ id: newId('dcn'), tenantId, provider: 'square', ...values })
      .onConflictDoUpdate({ target: [diaryConnections.tenantId, diaryConnections.provider], set: values })
      .returning();
    if (location) await queue.enqueue('sync-diary', { connectionId: row!.id });
    return diaryConnection(tenantId);
  }

  /** What the settings page shows. Never includes tokens. */
  async function diaryConnection(tenantId: string) {
    const [row] = await db.select().from(diaryConnections).where(eq(diaryConnections.tenantId, tenantId));
    return {
      available: { square: Boolean(square) },
      connection: row
        ? {
            provider: row.provider,
            locationName: row.locationName,
            consent: row.consent,
            status: row.status,
            error: row.error,
            lastSyncAt: row.lastSyncAt,
            connectedAt: row.createdAt,
          }
        : null,
    };
  }

  /** Stops reading the diary, withdraws our access at Square, and clears the free times it gave. */
  async function disconnectDiary(tenantId: string) {
    const [row] = await db.select().from(diaryConnections).where(eq(diaryConnections.tenantId, tenantId));
    if (!row) return;
    // Best effort: an expired token or Square being down must not stop the owner disconnecting.
    if (square) {
      try {
        await square.revoke(unseal(secret, row.accessToken));
      } catch {
        // Nothing to undo; access ends at Square when the token expires.
      }
    }
    await db.transaction(async (tx) => {
      await tx.delete(diaryConnections).where(eq(diaryConnections.id, row.id));
      await tx.delete(openSlots).where(and(eq(openSlots.tenantId, tenantId), gte(openSlots.startsAt, new Date())));
    });
  }

  // ---------------------------------------------------------------- syncing

  async function accessToken(row: Connection, now: Date) {
    // Square's tokens last 30 days; refresh a week early so a quiet spell never lets one lapse.
    if (row.refreshToken && row.expiresAt && row.expiresAt.getTime() < now.getTime() + 7 * DAY) {
      const fresh = await client().refresh(unseal(secret, row.refreshToken));
      await db
        .update(diaryConnections)
        .set({
          accessToken: seal(secret, fresh.accessToken),
          refreshToken: fresh.refreshToken ? seal(secret, fresh.refreshToken) : row.refreshToken,
          expiresAt: fresh.expiresAt,
          updatedAt: now,
        })
        .where(eq(diaryConnections.id, row.id));
      return fresh.accessToken;
    }
    return unseal(secret, row.accessToken);
  }

  /** Brings in the business's bookings and free times from Square. */
  async function syncDiary(connectionId: string, now = new Date()) {
    const [row] = await db.select().from(diaryConnections).where(eq(diaryConnections.id, connectionId));
    if (!row || !row.locationId) return;
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, row.tenantId));
    if (!tenant) return;
    try {
      const sq = client();
      const token = await accessToken(row, now);
      const from = new Date(now.getTime() - (row.lastSyncAt ? RESYNC_DAYS : FIRST_SYNC_DAYS) * DAY);
      const bookings = await sq.bookings(token, row.locationId, from, new Date(now.getTime() + AHEAD_DAYS * DAY));
      const segmentsOf = (b: SquareBooking) => b.appointment_segments ?? [];
      const customerIds = [...new Set(bookings.map((b) => b.customer_id).filter((id): id is string => Boolean(id)))];
      const serviceIds = [...new Set(bookings.flatMap((b) => segmentsOf(b).map((s) => s.service_variation_id)).filter((id): id is string => Boolean(id)))];
      const [customers, services] = await Promise.all([sq.customers(token, customerIds), sq.services(token, serviceIds)]);

      await bringInClients(row, [...customers.values()]);

      const rows = bookings.flatMap((b) => {
        const customer = b.customer_id ? customers.get(b.customer_id) : undefined;
        // Email is how the platform knows a client; Square bookings without one are left out.
        if (!customer?.email_address) return [];
        const segments = segmentsOf(b);
        const minutes = segments.reduce((sum, s) => sum + (s.duration_minutes ?? 0), 0);
        const named = segments.map((s) => (s.service_variation_id ? services.get(s.service_variation_id) : undefined)).filter((s) => s !== undefined);
        const price = named.reduce((sum, s) => sum + (s.price ?? 0), 0);
        const startsAt = new Date(b.start_at);
        return [
          {
            id: `square:${b.id}`,
            email: customer.email_address,
            firstName: customer.given_name,
            lastName: customer.family_name,
            startsAt: startsAt.toISOString(),
            ...(minutes && { endsAt: new Date(startsAt.getTime() + minutes * 60_000).toISOString() }),
            ...(named.length && { service: named.map((s) => s.name).join(' + ').slice(0, 256) }),
            ...(price && { price, currency: named.find((s) => s.currency)?.currency ?? 'GBP' }),
            status: statusOf(b, now),
            ...(b.created_at && { bookedAt: b.created_at }),
          },
        ];
      });
      const app = { id: tenant.appId };
      for (let i = 0; i < rows.length; i += 500) await diary.upsertAppointments(app, { tenant: tenant.externalId, appointments: rows.slice(i, i + 500) });

      // Free time is asked of Square for one service: the one the owner chose, else their most booked.
      const serviceId = row.serviceId ?? mostBooked(bookings);
      if (serviceId) {
        const to = new Date(now.getTime() + SLOT_DAYS * DAY);
        const free = await sq.availability(token, row.locationId, serviceId, now, to);
        const minutesOf = services.get(serviceId)?.minutes ?? 60;
        const slots = free.map((a) => {
          const startsAt = new Date(a.start_at);
          const segment = a.appointment_segments?.[0];
          return {
            startsAt: startsAt.toISOString(),
            endsAt: new Date(startsAt.getTime() + (segment?.duration_minutes ?? minutesOf) * 60_000).toISOString(),
            ...(segment?.team_member_id && { staff: segment.team_member_id }),
          };
        });
        await diary.setAvailability(app, { tenant: tenant.externalId, from: now.toISOString(), to: to.toISOString(), slots });
      }
      await db.update(diaryConnections).set({ status: 'active', error: null, lastSyncAt: now, updatedAt: now }).where(eq(diaryConnections.id, row.id));
    } catch (error) {
      // Owners see plain words; the detail goes to the logs.
      if (!(error instanceof PlatformError)) console.error('[diary sync]', row.id, error);
      const message =
        error instanceof PlatformError && error.code === 'square_unauthorised'
          ? 'Square no longer lets us read this diary. Connect it again from your settings.'
          : error instanceof PlatformError
            ? error.message
            : 'We could not read your Square diary just now. We will try again in 15 minutes.';
      await db.update(diaryConnections).set({ status: 'error', error: message.slice(0, 500), updatedAt: now }).where(eq(diaryConnections.id, row.id));
    }
  }

  /**
   * Square's clients as the business's contacts: names, phone and birthday fill gaps only. When the
   * owner confirmed consent, clients who have not unsubscribed in Square are added as agreeing to
   * news. Someone who unsubscribes in Square later loses the consent that came from Square; a yes
   * they gave the business another way (a sign-up form, say) is theirs and stays.
   */
  async function bringInClients(row: Connection, customers: SquareCustomer[]) {
    const withEmail = customers.filter((c) => c.email_address);
    const unsubscribed = (c: SquareCustomer) => c.preferences?.email_unsubscribed === true;
    const toRow = (c: SquareCustomer) => ({
      email: c.email_address,
      firstName: c.given_name,
      lastName: c.family_name,
      phone: c.phone_number,
      // Square writes "0000-03-14" when the year is unknown; only the day is kept either way.
      birthday: c.birthday?.replace(/^0000-/, ''),
    });
    const groups: [Consent, SquareCustomer[]][] =
      row.consent === 'granted'
        ? [
            ['granted', withEmail.filter((c) => !unsubscribed(c))],
            ['unknown', withEmail.filter(unsubscribed)],
          ]
        : [['unknown', withEmail]];
    for (const [consent, list] of groups) {
      if (!list.length) continue;
      for (let i = 0; i < list.length; i += IMPORT_BATCH) {
        await importClients(row.tenantId, { clients: list.slice(i, i + IMPORT_BATCH).map(toRow), consent }, SQUARE_CONSENT_SOURCE);
      }
    }
    const gone = withEmail.filter(unsubscribed).map((c) => c.email_address!.trim().toLowerCase());
    if (!gone.length) return;
    // Withdraw only consent whose newest record came from Square.
    const fromSquare = await db.execute<{ id: string }>(sql`
      select c.id from contacts c
      cross join lateral (select source from consents where contact_id = c.id order by recorded_at desc limit 1) latest
      where c.tenant_id = ${row.tenantId} and c.marketing_consent = 'granted' and latest.source = ${SQUARE_CONSENT_SOURCE}
        and c.email in (${sql.join(gone.map((e) => sql`${e}`), sql`, `)})`);
    for (const contact of fromSquare.rows) await setConsent(row.tenantId, contact.id, 'withdrawn', 'square:unsubscribed');
  }

  /** "Sync now" from the settings page: queues a sync rather than holding the request open. */
  async function syncDiaryNow(tenantId: string) {
    const [row] = await db.select({ id: diaryConnections.id }).from(diaryConnections).where(eq(diaryConnections.tenantId, tenantId));
    if (!row) throw new PlatformError('not_found', 'No booking system is connected.', 404);
    await queue.enqueue('sync-diary', { connectionId: row.id });
    return diaryConnection(tenantId);
  }

  /** The timer: one sync job per connected diary. */
  async function syncAllDiaries() {
    const rows = await db.select({ id: diaryConnections.id }).from(diaryConnections).orderBy(desc(diaryConnections.createdAt));
    await queue.enqueueMany('sync-diary', rows.map((r) => ({ data: { connectionId: r.id } })));
  }

  /** Square tells us a booking changed: sync that business now rather than on the next tick. */
  async function squareWebhook(rawBody: string, signature: string | undefined) {
    if (!client().verifyWebhook(webhookUrl, rawBody, signature)) throw new PlatformError('invalid_signature', 'Not signed by Square.', 401);
    const event = JSON.parse(rawBody) as { merchant_id?: string; type?: string };
    if (!event.merchant_id || !event.type?.startsWith('booking.')) return { synced: 0 };
    const rows = await db
      .select({ id: diaryConnections.id })
      .from(diaryConnections)
      .where(and(eq(diaryConnections.provider, 'square'), eq(diaryConnections.accountId, event.merchant_id)));
    await queue.enqueueMany('sync-diary', rows.map((r) => ({ data: { connectionId: r.id } })));
    return { synced: rows.length };
  }

  return { squareConnectUrl, connectReturnTenant, finishSquareConnect, diaryConnection, disconnectDiary, syncDiary, syncDiaryNow, syncAllDiaries, squareWebhook };
}

/** The service variation booked most often, to stand for the diary's free time. */
function mostBooked(bookings: SquareBooking[]) {
  const counts = new Map<string, number>();
  for (const b of bookings) for (const s of b.appointment_segments ?? []) if (s.service_variation_id) counts.set(s.service_variation_id, (counts.get(s.service_variation_id) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
