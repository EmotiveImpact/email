/**
 * Getting a business going on its own: bringing in its clients and their past visits from a
 * spreadsheet, and the short list of steps that take it to its first booked appointment from email.
 */
import { createHash } from 'node:crypto';
import { and, appointments, campaigns, consents, contacts, domains, eq, flows, newId, sql, tenants, type Db } from '@platform/db';
import { z } from 'zod';
import type { createDiary } from './diary.ts';
import { PlatformError } from './types.ts';

type Tenant = typeof tenants.$inferSelect;

/** Rows per request. The web app sends a big file in batches of this size. */
export const IMPORT_BATCH = 500;

const text = (max = 256) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || undefined);

const ClientRow = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  firstName: text(),
  lastName: text(),
  phone: text(64),
});

export const ImportClientsInput = z.object({
  clients: z.array(z.unknown()).min(1).max(IMPORT_BATCH),
  /**
   * "granted" only when the owner confirms these people agreed to hear news from them. Anyone who
   * has unsubscribed or said no before stays that way; an import never overrides a person's choice.
   */
  consent: z.enum(['granted', 'unknown']),
});

const VisitRow = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  firstName: text(),
  lastName: text(),
  date: z.coerce.date({ error: 'Use a date like 2026-07-01 or 01/07/2026.' }).refine((d) => d.getFullYear() > 1990, 'That date does not look right.'),
  service: text(),
  staff: text(),
  /** In pounds, as people type it: "45" or "£45.00". */
  price: z
    .union([z.number(), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return undefined;
      const n = typeof v === 'number' ? v : Number(v.replace(/[£$€,\s]/g, ''));
      if (!Number.isFinite(n) || n < 0) {
        ctx.addIssue({ code: 'custom', message: 'Price should be a number, like 45 or 45.00.' });
        return z.NEVER;
      }
      return Math.round(n * 100);
    }),
});

export const ImportVisitsInput = z.object({ visits: z.array(z.unknown()).min(1).max(IMPORT_BATCH) });

type Skipped = { row: number; reason: string };

function issue(error: z.ZodError) {
  const first = error.issues[0]!;
  const field = first.path.join('.');
  return field === 'email' ? 'No valid email address.' : `${field ? `${field}: ` : ''}${first.message}`;
}

export function createOnboarding({ db, diary }: { db: Db; diary: ReturnType<typeof createDiary> }) {
  async function tenantById(tenantId: string) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw new PlatformError('not_found', 'No such business.', 404);
    return tenant;
  }

  /** Adds or updates clients from a spreadsheet. Returns counts and the rows it could not use. */
  async function importClients(tenantId: string, raw: unknown) {
    const parsed = ImportClientsInput.safeParse(raw);
    if (!parsed.success) throw new PlatformError('invalid_request', issue(parsed.error), 422);
    const { clients, consent } = parsed.data;
    const skipped: Skipped[] = [];
    const rows = new Map<string, z.output<typeof ClientRow>>();
    clients.forEach((row, i) => {
      const r = ClientRow.safeParse(row);
      if (r.success) rows.set(r.data.email, r.data);
      else skipped.push({ row: i + 1, reason: issue(r.error) });
    });
    if (!rows.size) return { added: 0, updated: 0, consented: 0, skipped };

    return db.transaction(async (tx) => {
      const values = [...rows.values()].map((r) => ({
        id: newId('ctc'),
        tenantId,
        email: r.email,
        firstName: r.firstName ?? null,
        lastName: r.lastName ?? null,
        attributes: r.phone ? { phone: r.phone } : {},
      }));
      // Names fill gaps only, so an import never overwrites what the business already has.
      const saved = await tx
        .insert(contacts)
        .values(values)
        .onConflictDoUpdate({
          target: [contacts.tenantId, contacts.email],
          set: {
            firstName: sql`coalesce(${contacts.firstName}, excluded.first_name)`,
            lastName: sql`coalesce(${contacts.lastName}, excluded.last_name)`,
            attributes: sql`excluded.attributes || ${contacts.attributes}`,
            updatedAt: new Date(),
          },
        })
        .returning({ id: contacts.id, consent: contacts.marketingConsent, created: sql<boolean>`(xmax = 0)` });
      const added = saved.filter((s) => s.created).length;
      let consented = 0;
      if (consent === 'granted') {
        const fresh = saved.filter((s) => s.consent === 'unknown').map((s) => s.id);
        if (fresh.length) {
          const now = new Date();
          await tx.insert(consents).values(fresh.map((contactId) => ({ id: newId('con'), tenantId, contactId, status: 'granted' as const, source: 'import:owner-confirmed', recordedAt: now })));
          await tx
            .update(contacts)
            .set({ marketingConsent: 'granted', updatedAt: now })
            .where(and(eq(contacts.tenantId, tenantId), sql`${contacts.id} in (${sql.join(fresh.map((id) => sql`${id}`), sql`, `)})`));
          consented = fresh.length;
        }
      }
      return { added, updated: saved.length - added, consented, skipped };
    });
  }

  /** Past (and booked) visits from a spreadsheet, so each client's rhythm is known from day one. */
  async function importVisits(tenantId: string, raw: unknown) {
    const parsed = ImportVisitsInput.safeParse(raw);
    if (!parsed.success) throw new PlatformError('invalid_request', issue(parsed.error), 422);
    const tenant = await tenantById(tenantId);
    const skipped: Skipped[] = [];
    let saved = 0;
    const now = Date.now();
    for (const [i, row] of parsed.data.visits.entries()) {
      const r = VisitRow.safeParse(row);
      if (!r.success) {
        skipped.push({ row: i + 1, reason: issue(r.error) });
        continue;
      }
      const v = r.data;
      // The same visit imported twice updates itself instead of counting twice.
      const id = `import-${createHash('sha256').update(`${v.email}|${v.date.toISOString()}|${v.service ?? ''}`).digest('hex').slice(0, 24)}`;
      await diary.upsertAppointment(
        { id: tenant.appId },
        {
          tenant: tenant.externalId,
          id,
          email: v.email,
          firstName: v.firstName,
          lastName: v.lastName,
          startsAt: v.date,
          service: v.service,
          staff: v.staff,
          price: v.price,
          status: v.date.getTime() < now ? 'completed' : 'booked',
          bookedAt: v.date.getTime() < now ? v.date : new Date(),
        },
      );
      saved++;
    }
    return { saved, skipped };
  }

  /** The steps from signing up to the first booking from email, and which are done. */
  async function gettingStarted(tenantId: string) {
    const tenant = await tenantById(tenantId);
    const [[people], [visits], [domain], [flow], [sent]] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(eq(contacts.tenantId, tenantId)),
      db.select({ n: sql<number>`count(*)::int` }).from(appointments).where(eq(appointments.tenantId, tenantId)),
      db.select({ n: sql<number>`count(*)::int` }).from(domains).where(and(eq(domains.tenantId, tenantId), eq(domains.status, 'verified'))),
      db.select({ n: sql<number>`count(*)::int` }).from(flows).where(and(eq(flows.tenantId, tenantId), eq(flows.live, true))),
      db.select({ n: sql<number>`count(*)::int` }).from(campaigns).where(and(eq(campaigns.tenantId, tenantId), sql`${campaigns.status} in ('sending', 'sent')`)),
    ]);
    const steps = [
      { id: 'details', title: 'Add your address and booking link', done: Boolean(tenant.brand.address && tenant.brand.bookingUrl) },
      { id: 'clients', title: 'Bring in your clients', done: people!.n > 0 },
      { id: 'diary', title: 'Bring in your visits', done: visits!.n > 0 },
      { id: 'domain', title: 'Send from your own domain', done: domain!.n > 0 },
      { id: 'flow', title: 'Switch on a flow', done: flow!.n > 0 },
      { id: 'email', title: 'Send your first email', done: sent!.n > 0 },
    ];
    return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
  }

  return { importClients, importVisits, gettingStarted };
}
