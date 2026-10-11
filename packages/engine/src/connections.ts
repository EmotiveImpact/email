/**
 * Booking systems the platform reads directly (D132, D138). The owner grants read access once; from
 * then on a timer (and Square's webhooks, when set up) brings in bookings, clients and free times,
 * exactly as a host app would through the API. Square Appointments and Phorest so far.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { and, desc, diaryConnections, eq, gte, newId, openSlots, sql, tenants, type Db } from '@platform/db';
import type { createDiary } from './diary.ts';
import type { Queue } from './queue.ts';
import { seal, unseal } from './seal.ts';
import { IMPORT_BATCH, type createOnboarding } from './onboarding.ts';
import { PhorestClientApi, phorestStatus, wallTime, type PhorestAppointment, type PhorestClient, type PhorestLogin } from './phorest.ts';
import { SquareClient, statusOf, type SquareBooking } from './square.ts';
import { PlatformError } from './types.ts';

type Diary = ReturnType<typeof createDiary>;
type Consent = 'granted' | 'unknown';
type Connection = typeof diaryConnections.$inferSelect;
type Provider = Connection['provider'];

/** Where a yes that came from each booking system is recorded as coming from. */
export const CONSENT_SOURCES: Record<Provider, string> = {
  // Square has no consent field; the owner confirms it for everyone when connecting (D135).
  square: 'square:owner-confirmed',
  // Phorest records each client's own email marketing choice (D139).
  phorest: 'phorest:email-marketing-consent',
};
const PROVIDER_NAMES: Record<Provider, string> = { square: 'Square', phorest: 'Phorest' };

/** A client as the booking system describes them, and what it says about hearing news. */
type DiaryClient = { email: string; firstName?: string; lastName?: string; phone?: string; birthday?: string; says: 'yes' | 'no' | 'unknown' };
type AppointmentRow = Record<string, unknown> & { id: string; startsAt: string };
/** What one read of a booking system brings back. */
type Snapshot = { clients: DiaryClient[]; appointments: AppointmentRow[]; free: { to: Date; slots: { startsAt: string; endsAt: string; staff?: string }[] } | null };

const PhorestInput = z.object({
  username: z.string().trim().min(1, 'Paste the username Phorest sent you.').max(256),
  password: z.string().min(1, 'Paste the password Phorest sent you.').max(256),
  businessId: z.string().trim().min(1, 'Paste your Phorest business ID.').max(128),
  region: z.enum(['eu', 'us']).default('eu'),
  branchId: z.string().trim().max(128).optional(),
}) satisfies z.ZodType<Partial<PhorestLogin>>;

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
  doFetch,
  secret,
  webhookUrl,
}: {
  db: Db;
  queue: Queue;
  diary: Diary;
  importClients: ReturnType<typeof createOnboarding>['importClients'];
  setConsent: (tenantId: string, contactId: string, status: 'granted' | 'withdrawn', source: string) => Promise<boolean>;
  square: SquareClient | null;
  doFetch: typeof fetch;
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

  /** A business reads one booking system at a time, so its diary has one source of truth. */
  async function assertNoOther(tenantId: string, provider: Provider) {
    const [other] = await db.select({ provider: diaryConnections.provider }).from(diaryConnections).where(eq(diaryConnections.tenantId, tenantId));
    if (other && other.provider !== provider) {
      throw new PlatformError('already_connected', `${PROVIDER_NAMES[other.provider]} is connected. Disconnect it first.`, 409);
    }
  }

  function phorestFor(row: Connection) {
    const { username, password } = JSON.parse(unseal(secret, row.accessToken)) as { username: string; password: string };
    return new PhorestClientApi({ username, password, businessId: row.accountId, region: row.options.region ?? 'eu' }, doFetch);
  }

  /**
   * Phorest gives each salon its own API login on request; the owner pastes it here (D138). The
   * login is checked by listing the business's branches. With several branches and none chosen, the
   * branches come back for the owner to pick from, and nothing is saved yet.
   */
  async function connectPhorest(tenantId: string, raw: unknown) {
    const parsed = PhorestInput.safeParse(raw);
    if (!parsed.success) throw new PlatformError('invalid_request', parsed.error.issues[0]!.message, 422);
    const input = parsed.data;
    await assertNoOther(tenantId, 'phorest');
    const api = new PhorestClientApi(input, doFetch);
    let branches;
    try {
      branches = await api.branches();
    } catch (error) {
      if (error instanceof PlatformError && (error.code === 'phorest_unauthorised' || error.code === 'phorest_not_found')) {
        throw new PlatformError(
          'phorest_login',
          'Phorest did not accept that login. Check the username (it starts with “global/”), the password, the business ID and the region.',
          422,
        );
      }
      throw error;
    }
    const branch = input.branchId ? branches.find((b) => b.branchId === input.branchId) : branches.length === 1 ? branches[0] : undefined;
    if (!branch) {
      if (!branches.length) throw new PlatformError('phorest_login', 'That Phorest business has no branches.', 422);
      return { branches: branches.map((b) => ({ id: b.branchId, name: b.name })) };
    }
    const values = {
      accountId: input.businessId,
      locationId: branch.branchId,
      locationName: branch.name,
      accessToken: seal(secret, JSON.stringify({ username: input.username, password: input.password })),
      refreshToken: null,
      expiresAt: null,
      options: { region: input.region, timeZone: branch.timeZone ?? 'Europe/London', currency: branch.currencyCode ?? 'GBP' },
      status: 'active' as const,
      error: null,
      lastSyncAt: null,
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(diaryConnections)
      .values({ id: newId('dcn'), tenantId, provider: 'phorest', ...values })
      .onConflictDoUpdate({ target: [diaryConnections.tenantId, diaryConnections.provider], set: values })
      .returning();
    await queue.enqueue('sync-diary', { connectionId: row!.id });
    return diaryConnection(tenantId);
  }

  /** Square sent the owner back with a code. Saves the connection and starts the first sync. */
  async function finishSquareConnect(tenantId: string, userId: string, code: string, state: string) {
    const from = readState(state);
    if (!from || from.tenantId !== tenantId || from.userId !== userId) {
      throw new PlatformError('invalid_state', 'That link has expired. Start connecting again from this page.', 400);
    }
    await assertNoOther(tenantId, 'square');
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
      available: { square: Boolean(square), phorest: true },
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
    // Phorest logins cannot be withdrawn through the API; deleting the row forgets ours.
    if (square && row.provider === 'square') {
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

  /** Brings in the business's bookings, clients and free times from its booking system. */
  async function syncDiary(connectionId: string, now = new Date()) {
    const [row] = await db.select().from(diaryConnections).where(eq(diaryConnections.id, connectionId));
    if (!row || !row.locationId) return;
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, row.tenantId));
    if (!tenant) return;
    const name = PROVIDER_NAMES[row.provider];
    try {
      const snapshot = row.provider === 'square' ? await readSquare(row, now) : await readPhorest(row, now);
      await bringInClients(row, snapshot.clients);
      const app = { id: tenant.appId };
      const rows = snapshot.appointments;
      for (let i = 0; i < rows.length; i += 500) await diary.upsertAppointments(app, { tenant: tenant.externalId, appointments: rows.slice(i, i + 500) });
      if (snapshot.free) {
        await diary.setAvailability(app, { tenant: tenant.externalId, from: now.toISOString(), to: snapshot.free.to.toISOString(), slots: snapshot.free.slots });
      }
      await db.update(diaryConnections).set({ status: 'active', error: null, lastSyncAt: now, updatedAt: now }).where(eq(diaryConnections.id, row.id));
    } catch (error) {
      // Owners see plain words; the detail goes to the logs.
      if (!(error instanceof PlatformError)) console.error('[diary sync]', row.id, error);
      const message =
        error instanceof PlatformError && error.code === `${row.provider}_unauthorised`
          ? `${name} no longer lets us read this diary. Connect it again from your settings.`
          : error instanceof PlatformError
            ? error.message
            : `We could not read your ${name} diary just now. We will try again in 15 minutes.`;
      await db.update(diaryConnections).set({ status: 'error', error: message.slice(0, 500), updatedAt: now }).where(eq(diaryConnections.id, row.id));
    }
  }

  /** The first read reaches back six months; later ones a week, to catch late changes. */
  const windowFor = (row: Connection, now: Date) => ({
    from: new Date(now.getTime() - (row.lastSyncAt ? RESYNC_DAYS : FIRST_SYNC_DAYS) * DAY),
    to: new Date(now.getTime() + AHEAD_DAYS * DAY),
  });

  async function readSquare(row: Connection, now: Date): Promise<Snapshot> {
    const sq = client();
    const token = await accessToken(row, now);
    const { from, to } = windowFor(row, now);
    const bookings = await sq.bookings(token, row.locationId!, from, to);
    const segmentsOf = (b: SquareBooking) => b.appointment_segments ?? [];
    const customerIds = [...new Set(bookings.map((b) => b.customer_id).filter((id): id is string => Boolean(id)))];
    const serviceIds = [...new Set(bookings.flatMap((b) => segmentsOf(b).map((s) => s.service_variation_id)).filter((id): id is string => Boolean(id)))];
    const [customers, services] = await Promise.all([sq.customers(token, customerIds), sq.services(token, serviceIds)]);

    // The owner's answer stands for everyone, except a client who unsubscribed in Square.
    const clients: DiaryClient[] = [...customers.values()]
      .filter((c) => c.email_address)
      .map((c) => ({
        email: c.email_address!,
        firstName: c.given_name,
        lastName: c.family_name,
        phone: c.phone_number,
        // Square writes "0000-03-14" when the year is unknown; only the day is kept either way.
        birthday: c.birthday?.replace(/^0000-/, ''),
        says: c.preferences?.email_unsubscribed === true ? 'no' : row.consent === 'granted' ? 'yes' : 'unknown',
      }));

    const appointments = bookings.flatMap((b) => {
      const customer = b.customer_id ? customers.get(b.customer_id) : undefined;
      // Email is how the platform knows a client; bookings without one are left out.
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

    // Free time is asked of Square for one service: the one the owner chose, else their most booked.
    const serviceId = row.serviceId ?? mostBooked(bookings.flatMap((b) => segmentsOf(b).map((s) => s.service_variation_id)));
    if (!serviceId) return { clients, appointments, free: null };
    const until = new Date(now.getTime() + SLOT_DAYS * DAY);
    const free = await sq.availability(token, row.locationId!, serviceId, now, until);
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
    return { clients, appointments, free: { to: until, slots } };
  }

  async function readPhorest(row: Connection, now: Date): Promise<Snapshot> {
    const api = phorestFor(row);
    const branchId = row.locationId!;
    const timeZone = row.options.timeZone ?? 'Europe/London';
    const currency = row.options.currency ?? 'GBP';
    const { from, to } = windowFor(row, now);
    const [all, services] = await Promise.all([api.appointments(branchId, from, to), api.services(branchId)]);
    const serviceById = new Map(services.map((s) => [s.serviceId, s]));

    // Phorest keeps each service in a visit as its own appointment; a visit is one booking here,
    // so a cut and colour counts once in the client's rhythm.
    const visits = new Map<string, PhorestAppointment[]>();
    for (const a of all) {
      if (!a.clientId) continue;
      const key = a.bookingId ?? a.appointmentId;
      visits.set(key, [...(visits.get(key) ?? []), a]);
    }

    const ids = [...new Set([...visits.values()].map((v) => v[0]!.clientId!))];
    const people = new Map((await api.clients(ids)).map((c) => [c.clientId, c]));
    if (row.lastSyncAt) {
      // A change of mind with no new booking. Best effort: the bookings matter more than this.
      try {
        for (const c of await api.clientsUpdatedSince(new Date(row.lastSyncAt.getTime() - 60 * 60_000))) people.set(c.clientId, c);
      } catch (error) {
        console.error('[diary sync] Phorest client changes', row.id, error);
      }
    }
    const usable = (c: PhorestClient | undefined): c is PhorestClient & { email: string } => Boolean(c?.email && !c.deleted && !c.banned);
    // Phorest records each client's own email marketing choice, so that is what we follow.
    const clients: DiaryClient[] = [...people.values()].filter(usable).map((c) => ({
      email: c.email,
      firstName: c.firstName,
      lastName: c.lastName,
      phone: c.mobile,
      birthday: c.birthDate,
      says: c.emailMarketingConsent === true ? 'yes' : c.emailMarketingConsent === false ? 'no' : 'unknown',
    }));

    const appointments = [...visits.entries()].flatMap(([key, parts]) => {
      const person = people.get(parts[0]!.clientId!);
      if (!usable(person)) return [];
      const timed = parts.map((a) => ({ a, startsAt: wallTime(a.appointmentDate, a.startTime, timeZone) }));
      const statuses = timed.map(({ a, startsAt }) => phorestStatus(a, startsAt, now));
      const live = timed.filter((_, i) => statuses[i] !== 'cancelled');
      const counted = live.length ? live : timed;
      const startsAt = new Date(Math.min(...counted.map((t) => t.startsAt.getTime())));
      const ends = counted.flatMap(({ a }) => (a.endTime ? [wallTime(a.appointmentDate, a.endTime, timeZone).getTime()] : []));
      const names = [...new Set(counted.map(({ a }) => a.serviceName ?? (a.serviceId ? serviceById.get(a.serviceId)?.name : undefined)).filter(Boolean))];
      const price = Math.round(counted.reduce((sum, { a }) => sum + (a.price ?? 0), 0) * 100);
      const created = parts.flatMap((a) => (a.createdAt ? [new Date(a.createdAt).getTime()] : []));
      return [
        {
          id: `phorest:${key}`,
          email: person.email,
          firstName: person.firstName,
          lastName: person.lastName,
          startsAt: startsAt.toISOString(),
          ...(ends.length && { endsAt: new Date(Math.max(...ends)).toISOString() }),
          ...(names.length && { service: names.join(' + ').slice(0, 256) }),
          ...(price && { price, currency }),
          status: live.length ? (statuses.includes('completed') ? 'completed' : 'booked') : 'cancelled',
          ...(created.length && { bookedAt: new Date(Math.min(...created)).toISOString() }),
        } as const,
      ];
    });

    const serviceId = row.serviceId ?? mostBooked(all.filter((a) => !a.deleted && a.activationState !== 'CANCELED').map((a) => a.serviceId));
    if (!serviceId) return { clients, appointments, free: null };
    const until = new Date(now.getTime() + SLOT_DAYS * DAY);
    const minutes = serviceById.get(serviceId)?.duration ?? 60;
    const slots = (await api.availability(branchId, serviceId, now, until)).map((slot) => {
      const startsAt = new Date(slot.startTime);
      return { startsAt: startsAt.toISOString(), endsAt: slot.endTime ? new Date(slot.endTime).toISOString() : new Date(startsAt.getTime() + minutes * 60_000).toISOString() };
    });
    return { clients, appointments, free: { to: until, slots } };
  }

  /**
   * Clients as the business's contacts: names, phone and birthday fill gaps only. A client the
   * booking system says agreed to news is added as agreeing. One it says has said no loses a yes that
   * came from that system; a yes they gave the business another way (a sign-up form, say) stays.
   */
  async function bringInClients(row: Connection, clients: DiaryClient[]) {
    const source = CONSENT_SOURCES[row.provider];
    const toRow = ({ says: _, ...c }: DiaryClient) => c;
    const groups: [Consent, DiaryClient[]][] = [
      ['granted', clients.filter((c) => c.says === 'yes')],
      ['unknown', clients.filter((c) => c.says !== 'yes')],
    ];
    for (const [consent, list] of groups) {
      for (let i = 0; i < list.length; i += IMPORT_BATCH) {
        await importClients(row.tenantId, { clients: list.slice(i, i + IMPORT_BATCH).map(toRow), consent }, source);
      }
    }
    const gone = clients.filter((c) => c.says === 'no').map((c) => c.email.trim().toLowerCase());
    if (!gone.length) return;
    const fromThere = await db.execute<{ id: string }>(sql`
      select c.id from contacts c
      cross join lateral (select source from consents where contact_id = c.id order by recorded_at desc limit 1) latest
      where c.tenant_id = ${row.tenantId} and c.marketing_consent = 'granted' and latest.source = ${source}
        and c.email in (${sql.join(gone.map((e) => sql`${e}`), sql`, `)})`);
    for (const contact of fromThere.rows) await setConsent(row.tenantId, contact.id, 'withdrawn', `${row.provider}:unsubscribed`);
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

  return { squareConnectUrl, connectReturnTenant, finishSquareConnect, connectPhorest, diaryConnection, disconnectDiary, syncDiary, syncDiaryNow, syncAllDiaries, squareWebhook };
}

/** The service booked most often, to stand for the diary's free time. */
function mostBooked(serviceIds: (string | undefined)[]) {
  const counts = new Map<string, number>();
  for (const id of serviceIds) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
