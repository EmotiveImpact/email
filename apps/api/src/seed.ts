/**
 * Demo data: the Emotive Impact account with Saleane and Caleane as apps, a studio in each,
 * sixty salon clients with booking history, a month of sent email, and a person who can sign in.
 * Run it on an empty database (`pnpm db:migrate` first).
 */
import { campaigns, contacts, eq, flowSends, members, messageEvents, messages, newId } from '@platform/db';
import { boot } from './runtime.ts';

const { db, engine, queue, pool, auth } = await boot();

const { accountId, appId: saleane } = await engine.createAccountWithApp({ account: 'Emotive Impact', app: 'Saleane' });
const caleane = (await engine.createApp(accountId, 'Caleane')).id;

const linden = await engine.upsertTenant(saleane, 'linden', {
  name: 'Linden Studio',
  fromEmail: 'news@linden.example',
  brand: { accent: '#D9481F', rail: 'pigment', headingFont: 'cal-sans', address: 'Linden Studio, 4 Linden Row, Leeds LS1 4AB', bookingUrl: 'https://linden.example/book' },
  timezone: 'Europe/London',
});
const harbour = await engine.upsertTenant(caleane, 'harbour-films', { name: 'Harbour Films', fromEmail: 'hello@harbourfilms.example', brand: { accent: '#4B4FD8', rail: 'light' } });

const saleaneKey = await engine.createApiKey(saleane, 'Saleane server');
const caleaneKey = await engine.createApiKey(caleane, 'Caleane server');
const app = await engine.authenticate(saleaneKey.key);
// The demo host page (`pnpm demo:host`) shows Saleane's embedded studio from this origin.
await engine.setEmbedOrigins(saleane, { origins: ['http://localhost:3000'] });

// ---------------------------------------------------------------- clients and their bookings

let seed = 7;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000 - random() * 36_000_000).toISOString();

const FIRST = ['Ama', 'Kofi', 'Maya', 'Lena', 'Priya', 'Tom', 'Grace', 'Sam', 'Chloe', 'Ade', 'Hannah', 'Leo', 'Zara', 'Ben', 'Ife', 'Ruth', 'Omar', 'Erin', 'Jade', 'Theo'];
const LAST = ['Mensah', 'Owusu', 'Patel', 'Clarke', 'Hughes', 'Okafor', 'Bennett', 'Shah', 'Evans', 'Adeyemi', 'Wright', 'Khan'];
const TREATMENTS = ['Facial', 'Massage', 'Brows', 'Nails', 'Lashes'] as const;
const PRICES: Record<(typeof TREATMENTS)[number], number> = { Facial: 6500, Massage: 7000, Brows: 2500, Nails: 3500, Lashes: 4500 };
let booking = 0;
/** A visit in the diary, as Saleane would send it. */
const visit = (email: string, startsAt: Date, options: { status?: 'booked' | 'completed' | 'cancelled'; bookedAt?: Date; treatment?: (typeof TREATMENTS)[number] } = {}) => {
  const treatment = options.treatment ?? pick(TREATMENTS);
  return engine.upsertAppointment(app, {
    tenant: 'linden',
    id: `saleane-${++booking}`,
    email,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3_600_000),
    service: treatment,
    staff: pick(STYLISTS),
    price: PRICES[treatment],
    status: options.status ?? (startsAt.getTime() < Date.now() ? 'completed' : 'booked'),
    bookedAt: options.bookedAt ?? new Date(Math.min(Date.now(), startsAt.getTime()) - (2 + random() * 18) * 86_400_000),
  });
};
const STYLISTS = ['Maya', 'Jo', 'Priya'] as const;

const clients: { email: string; rhythm: number; lastVisit: number }[] = [];
for (let i = 0; i < 60; i++) {
  const firstName = FIRST[i % FIRST.length]!;
  const lastName = pick(LAST);
  const email = `${firstName}.${lastName}${i}@example.com`.toLowerCase();
  // Each client has a rhythm: some come every three weeks, some every couple of months.
  const rhythm = pick([21, 28, 35, 42, 56, 90]);
  const lastVisit = Math.floor(random() * rhythm * 1.8);
  const visits = 1 + Math.floor(random() * 8);
  const consent = random() < 0.72 ? 'granted' : random() < 0.5 ? 'withdrawn' : undefined;
  await engine.upsertContact(app, {
    tenant: 'linden',
    email,
    firstName,
    lastName,
    attributes: { treatment: pick(TREATMENTS), stylist: pick(STYLISTS), visits, spend: visits * (40 + Math.floor(random() * 50)) },
    ...(consent && { consent: { marketing: consent, source: random() < 0.6 ? 'saleane:booking-form' : 'saleane:front-desk' } }),
  });
  // Clients mostly stick to one treatment.
  const usual = pick(TREATMENTS);
  for (let v = 0; v < visits; v++) {
    await visit(email, new Date(daysAgo(lastVisit + v * rhythm)), { treatment: random() < 0.8 ? usual : undefined });
  }
  if (random() < 0.15) await visit(email, new Date(daysAgo(Math.floor(random() * 60))), { status: 'cancelled' });
  clients.push({ email, rhythm, lastVisit });
}

// ---------------------------------------------------------------- the next fortnight: bookings and free time

// Open Tuesday to Saturday, 9am to 6pm, three stylists. Tuesdays and Thursdays run quiet.
const QUIET: Record<number, number> = { 2: 0.4, 3: 0.15, 4: 0.45, 5: 0.12, 6: 0.05 };
const freeSlots: { startsAt: Date; endsAt: Date; staff: string }[] = [];
const from = new Date();
from.setUTCHours(0, 0, 0, 0);
for (let d = 1; d <= 14; d++) {
  const day = new Date(from.getTime() + d * 86_400_000);
  const chance = QUIET[day.getUTCDay()];
  if (chance === undefined) continue;
  for (const staff of STYLISTS) {
    for (let hour = 8; hour < 17; hour++) {
      const startsAt = new Date(day.getTime() + hour * 3_600_000); // 9am to 5pm in London
      if (random() < chance) freeSlots.push({ startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), staff });
      else if (random() < 0.35) await visit(pick(clients).email, startsAt);
    }
  }
}
await engine.setAvailability(app, { tenant: 'linden', from, to: new Date(from.getTime() + 15 * 86_400_000), slots: freeSlots });

await engine.ensureStarterSegments(linden.id);
await engine.ensureStarterSegments(harbour.id);

// ---------------------------------------------------------------- a month of sending

const subjects = [
  ['transactional', 'Your appointment is confirmed'],
  ['transactional', 'See you tomorrow at 10:00'],
  ['transactional', 'Your receipt from Linden Studio'],
  ['marketing', 'Thursday has space for you'],
  ['marketing', 'Autumn treatments are here'],
] as const;
const history: (typeof messages.$inferInsert)[] = [];
for (let ago = 30; ago >= 1; ago--) {
  const weekend = new Date(Date.now() - ago * 86_400_000).getUTCDay() % 6 === 0;
  const count = Math.round((weekend ? 6 : 14) + random() * 8 + (30 - ago) * 0.35);
  for (let i = 0; i < count; i++) {
    const [stream, subject] = pick(subjects);
    const roll = random();
    const status = roll < 0.012 ? 'bounced' : roll < 0.014 ? 'complained' : roll < 0.03 ? 'suppressed' : 'delivered';
    const at = new Date(Date.now() - ago * 86_400_000 + random() * 36_000_000);
    history.push({
      id: newId('msg'),
      tenantId: linden.id,
      stream,
      to: `client${Math.floor(random() * 400)}@example.com`,
      from: 'Linden Studio <news@linden.example>',
      subject,
      text: 'Seeded history.',
      status,
      error: status === 'suppressed' ? (stream === 'marketing' ? 'no_marketing_consent' : 'hard_bounce') : null,
      createdAt: at,
      sentAt: status === 'suppressed' ? null : at,
    });
  }
}
await db.insert(messages).values(history);
await engine.sendEmail(app, { tenant: 'linden', to: 'ama.mensah0@example.com', subject: 'Your facial is on Thursday at 10:00', text: 'See you then.' });

// ---------------------------------------------------------------- campaigns: one sent, one scheduled, one draft

const book = 'https://linden.example/book';
const autumn = await engine.createCampaign(linden.id, {
  name: 'Autumn treatments',
  subject: 'Autumn treatments are here, {{first_name|friend}}',
  content: {
    preview: 'Warming facials and a new hot-stone massage.',
    blocks: [
      { id: 'a1', type: 'heading', text: 'Autumn treatments are here' },
      { id: 'a2', type: 'text', text: 'Hi {{first_name|there}},\n\nAs the evenings draw in we have added a **warming enzyme facial** and a *hot-stone back massage* to the menu. Both are 60 minutes and both come with a cup of our spiced tea.' },
      { id: 'a3', type: 'button', label: 'Book an autumn treatment', url: book },
      { id: 'a4', type: 'divider' },
      { id: 'a5', type: 'text', text: 'Already booked? We will see you soon.\n\nMaya, Jo and Priya' },
    ],
  },
});
await engine.scheduleCampaign(linden.id, autumn.id);
await engine.processCampaign(autumn.id);
// Pretend it went nine days ago and people have read it since.
const nineDaysAgo = new Date(Date.now() - 9 * 86_400_000);
const sent = await db.select({ id: messages.id }).from(messages).where(eq(messages.campaignId, autumn.id));
const events: (typeof messageEvents.$inferInsert)[] = [];
for (const [i, m] of sent.entries()) {
  const bounced = i === 3;
  await db.update(messages).set({ status: bounced ? 'bounced' : 'delivered', sentAt: nineDaysAgo, createdAt: nineDaysAgo }).where(eq(messages.id, m.id));
  if (bounced) continue;
  const later = (h: number) => new Date(nineDaysAgo.getTime() + h * 3_600_000);
  if (random() < 0.52) events.push({ id: newId('mev'), messageId: m.id, type: 'open', occurredAt: later(1 + random() * 40) });
  if (random() < 0.11) events.push({ id: newId('mev'), messageId: m.id, type: 'click', occurredAt: later(2 + random() * 40) });
}
if (sent[5]) events.push({ id: newId('mev'), messageId: sent[5].id, type: 'unsubscribe', occurredAt: new Date(nineDaysAgo.getTime() + 7_200_000) });
if (events.length) await db.insert(messageEvents).values(events);
await db.update(campaigns).set({ sentAt: nineDaysAgo, scheduledAt: nineDaysAgo, createdAt: nineDaysAgo, updatedAt: nineDaysAgo }).where(eq(campaigns.id, autumn.id));

const due = (await engine.listSegments(linden.id)).find((s) => s.name === 'Due for a visit');
const halfTerm = await engine.createCampaign(linden.id, {
  name: 'Half-term pamper week',
  subject: 'A quiet hour for you this half-term',
  segmentId: due?.id ?? null,
  content: {
    preview: 'Weekday mornings are open while the kids are off.',
    blocks: [
      { id: 'h1', type: 'heading', text: 'Half-term, with an hour to yourself' },
      { id: 'h2', type: 'text', text: 'Hi {{first_name|there}},\n\nIt has been a little while since your last visit. Weekday mornings are open over half-term if you fancy a reset.' },
      { id: 'h3', type: 'button', label: 'Pick a morning', url: book },
    ],
  },
});
await engine.scheduleCampaign(linden.id, halfTerm.id, new Date(Date.now() + 3 * 86_400_000));

const draft = await engine.createCampaign(linden.id, { name: 'Thursday has space', subject: '{{first_name|Hi}}, Thursday has space' });
const content = draft.content as { blocks: { type: string; url?: string }[] };
await engine.updateCampaign(linden.id, draft.id, { content: { ...content, blocks: content.blocks.map((b) => (b.type === 'button' ? { ...b, url: book } : b)) } });

// ---------------------------------------------------------------- flows, and the bookings that followed

const flows = await engine.listFlows(linden.id);
for (const kind of ['welcome', 'rebook', 'fill_slots'] as const) await engine.updateFlow(linden.id, flows.find((f) => f.kind === kind)!.id, { live: true });
const rebook = flows.find((f) => f.kind === 'rebook')!;
const fill = flows.find((f) => f.kind === 'fill_slots')!;
const people = await db.select({ id: contacts.id, email: contacts.email }).from(contacts).where(eq(contacts.tenantId, linden.id));
// A month of flow emails: about a third led to a booking within a few days.
for (const [i, person] of people.slice(0, 26).entries()) {
  const flow = i % 3 === 0 ? fill : rebook;
  const at = new Date(Date.now() - (4 + random() * 26) * 86_400_000);
  const id = newId('msg');
  await db.insert(messages).values({
    id,
    tenantId: linden.id,
    flowId: flow.id,
    stream: 'marketing',
    to: person.email,
    from: 'Linden Studio <news@linden.example>',
    subject: flow.kind === 'rebook' ? 'Time for your next Facial?' : 'Space on Thursday',
    text: 'Seeded history.',
    tags: { flow: flow.id, kind: flow.kind },
    status: 'delivered',
    createdAt: at,
    sentAt: at,
  });
  await db.insert(flowSends).values({ id: newId('fsd'), flowId: flow.id, contactId: person.id, reason: `seed:${i}`, messageId: id, createdAt: at });
  if (random() < 0.55) await db.insert(messageEvents).values({ id: newId('mev'), messageId: id, type: 'open', occurredAt: new Date(at.getTime() + 3_600_000) });
  const bookedAt = new Date(at.getTime() + (2 + random() * 60) * 3_600_000);
  if (random() < 0.38) await visit(person.email, new Date(Math.min(at.getTime() + (3 + random() * 10) * 86_400_000, Date.now() - 86_400_000)), { bookedAt });
}
// And some bookings after the autumn campaign.
for (const m of sent.slice(0, 40)) {
  if (random() > 0.18) continue;
  const [row] = await db.select({ to: messages.to }).from(messages).where(eq(messages.id, m.id));
  await visit(row!.to, new Date(Math.min(nineDaysAgo.getTime() + (4 + random() * 6) * 86_400_000, Date.now() - 86_400_000)), { bookedAt: new Date(nineDaysAgo.getTime() + (3 + random() * 70) * 3_600_000) });
}

// ---------------------------------------------------------------- someone to sign in as

const email = 'demo@example.com';
const password = 'linden-demo-2026';
const { user } = await auth.api.signUpEmail({ body: { name: 'Edem', email, password } });
await db.insert(members).values({ id: newId('mem'), organizationId: accountId, userId: user.id, role: 'owner' });

console.log(`
Seeded. Sign in at http://localhost:5173 with
  ${email} / ${password}

API keys (shown once):
  Saleane: ${saleaneKey.key}
  Caleane: ${caleaneKey.key}
`);
await queue.stop();
await pool.end();
